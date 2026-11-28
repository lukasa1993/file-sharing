import { AwsClient } from 'aws4fetch'
import { ContentDisposition } from 'remix/headers'

export type R2Part = { partNumber: number; etag: string }
type Multipart = {
  uploadId: string
  complete(parts: R2Part[]): Promise<unknown>
  abort(): Promise<void>
}
export interface R2ControlBinding {
  createMultipartUpload(
    key: string,
    options: {
      httpMetadata: {
        contentType: string
        contentDisposition: string
        cacheControl: string
      }
    },
  ): Promise<Multipart>
  resumeMultipartUpload(key: string, uploadId: string): Multipart
  head(key: string): Promise<{ size: number } | null>
  delete(key: string): Promise<void>
}
export interface R2Environment {
  BUCKET: R2ControlBinding
  R2_ACCOUNT_ID: string
  R2_BUCKET_NAME: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  R2_JURISDICTION?: 'eu' | 'fedramp'
}
interface Options {
  /** Only used by fixtures running an explicitly separate loopback S3 service. */
  endpoint?: string
  now?: () => number
  fetch?: (request: Request) => Promise<Response>
}
const utf8 = new TextEncoder()
const maxPartBytes = 5 * 1024 ** 3 - 5 * 1024 ** 2
const maxParts = 10_000
const maxUrlSeconds = 15 * 60
const pageLimit = 4
const pageBytes = 512 * 1024

function keyPath(key: string) {
  const segments = key.split('/')
  if (
    !key.isWellFormed() ||
    utf8.encode(key).length > 1024 ||
    /[\\\u0000-\u001f\u007f]/.test(key) ||
    segments.some((s) => !s || s === '.' || s === '..')
  )
    throw new RangeError('Invalid R2 object key.')
  return segments.map(encodeURIComponent).join('/')
}
function uploadIdentifier(id: string) {
  if (!id || id.length > 2048 || /[\u0000-\u001f\u007f]/.test(id))
    throw new RangeError('Invalid R2 upload ID.')
  return id
}
function partNumber(n: number) {
  if (!Number.isInteger(n) || n < 1 || n > maxParts)
    throw new RangeError('Invalid multipart part number.')
  return n
}
function attachment(name: string) {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    !name.isWellFormed() ||
    /[/\\\u0000-\u001f\u007f]/.test(name) ||
    utf8.encode(name).length > 255
  )
    throw new RangeError('Invalid download filename.')
  const ascii = name.replace(/[^\x20-\x7e]|["%;]/g, '_')
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
  return new ContentDisposition({
    type: 'attachment',
    filename: ascii,
    filenameSplat: "UTF-8''" + encoded,
  }).toString()
}
function normalizedEtag(input: string) {
  const value =
    input.startsWith('"') && input.endsWith('"') ? input.slice(1, -1) : input
  if (!/^[\x21\x23-\x7e]{1,1024}$/.test(value))
    throw new RangeError('Invalid multipart ETag.')
  return value
}

// Only trusted S3 metadata is consumed here. Never consume object bodies on the Worker.
async function controlXml(response: Response) {
  if (
    !response.ok ||
    Number(response.headers.get('content-length') ?? 0) > pageBytes
  ) {
    await response.body?.cancel()
    throw new Error('R2 multipart listing unavailable.')
  }
  if (!response.body) throw new Error('Missing R2 multipart listing.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let length = 0,
    xml = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > pageBytes)
        throw new Error('R2 multipart listing exceeded its bound.')
      xml += decoder.decode(chunk.value, { stream: true })
    }
    xml += decoder.decode()
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const root =
    /^\s*(?:<\?xml\s+[^?]*\?>\s*)?<ListMultipartUploadsResult(?:\s+xmlns="[^"]*")?>([\s\S]*)<\/ListMultipartUploadsResult>\s*$/.exec(
      xml,
    )?.[1]
  if (root === undefined || /<!|<\?/.test(root))
    throw new Error('Invalid R2 multipart listing.')
  return root
}
function xmlField(xml: string, tag: string) {
  const fields = [
    ...xml.matchAll(new RegExp('<' + tag + '>([^<]*)</' + tag + '>', 'g')),
  ]
  const raw = fields[0]?.[1]
  if (
    fields.length !== 1 ||
    raw === undefined ||
    /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(raw)
  )
    throw new Error('Invalid R2 multipart listing field.')
  return raw.replace(
    /&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g,
    (_all, entity: string) => {
      if (entity.startsWith('#'))
        return String.fromCodePoint(
          entity[1] === 'x'
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1)),
        )
      return (
        (
          { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<
            string,
            string
          >
        )[entity] ?? ''
      )
    },
  )
}

export class R2Transfers {
  private readonly signer: AwsClient
  private readonly bucketUrl: string
  private readonly now: () => number
  private readonly http: (request: Request) => Promise<Response>

  constructor(
    private readonly env: R2Environment,
    options: Options = {},
  ) {
    if (
      !/^[a-fA-F0-9]{32}$/.test(env.R2_ACCOUNT_ID) ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET_NAME) ||
      !env.R2_ACCESS_KEY_ID ||
      !env.R2_SECRET_ACCESS_KEY
    )
      throw new Error('Invalid R2 configuration.')
    if (
      env.R2_JURISDICTION !== undefined &&
      !['eu', 'fedramp'].includes(env.R2_JURISDICTION)
    )
      throw new Error('Invalid R2 jurisdiction.')
    let origin =
      'https://' +
      env.R2_ACCOUNT_ID +
      (env.R2_JURISDICTION ? '.' + env.R2_JURISDICTION : '') +
      '.r2.cloudflarestorage.com'
    if (options.endpoint !== undefined) {
      const url = new URL(options.endpoint)
      if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        throw new Error('Local R2 endpoint must be a loopback HTTP origin.')
      origin = url.origin
    }
    this.bucketUrl = origin + '/' + env.R2_BUCKET_NAME
    this.signer = new AwsClient({
      service: 's3',
      region: 'auto',
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    })
    this.now = options.now ?? Date.now
    this.http = options.fetch ?? ((request) => fetch(request))
  }

  async create(key: string, name: string) {
    keyPath(key)
    const upload = await this.env.BUCKET.createMultipartUpload(key, {
      httpMetadata: {
        contentType: 'application/octet-stream',
        contentDisposition: attachment(name),
        cacheControl: 'private, no-store, no-transform',
      },
    })
    return uploadIdentifier(upload.uploadId)
  }

  private async presign(
    url: URL,
    method: 'GET' | 'PUT',
    expiresAtMs: number,
    headers?: Record<string, string>,
  ) {
    const now = Math.floor(this.now() / 1000)
    const ttl = Math.min(maxUrlSeconds, Math.floor(expiresAtMs / 1000) - now)
    if (
      !Number.isSafeInteger(expiresAtMs) ||
      !Number.isSafeInteger(ttl) ||
      ttl < 1
    )
      throw new RangeError('R2 URL authorization has expired.')
    url.searchParams.set('X-Amz-Expires', String(ttl))
    const datetime = new Date(now * 1000)
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, '')
    // aws4fetch excludes content-length by default. Only our explicit headers
    // enter this signature; browsers supply Content-Length for the Blob PUT.
    return (
      await this.signer.sign(url, {
        method,
        ...(headers ? { headers } : {}),
        aws: { signQuery: true, allHeaders: true, datetime },
      })
    ).url
  }
  part(
    key: string,
    uploadId: string,
    number: number,
    size: number,
    expiresAtMs: number,
  ) {
    if (!Number.isSafeInteger(size) || size < 0 || size > maxPartBytes)
      throw new RangeError('Invalid multipart part size.')
    const url = new URL(this.bucketUrl + '/' + keyPath(key))
    url.searchParams.set('uploadId', uploadIdentifier(uploadId))
    url.searchParams.set('partNumber', String(partNumber(number)))
    return this.presign(url, 'PUT', expiresAtMs, {
      'Content-Length': String(size),
    })
  }
  async complete(key: string, id: string, parts: R2Part[]) {
    keyPath(key)
    uploadIdentifier(id)
    if (!parts.length || parts.length > maxParts)
      throw new RangeError('Invalid multipart completion.')
    const normalized = parts
      .map(({ partNumber: n, etag }) => ({
        partNumber: partNumber(n),
        etag: normalizedEtag(etag),
      }))
      .sort((a, b) => a.partNumber - b.partNumber)
    if (normalized.some((part, index) => part.partNumber !== index + 1))
      throw new RangeError('Multipart completion requires consecutive parts.')
    await this.env.BUCKET.resumeMultipartUpload(key, id).complete(normalized)
  }
  async abort(key: string, id: string) {
    keyPath(key)
    uploadIdentifier(id)
    try {
      await this.env.BUCKET.resumeMultipartUpload(key, id).abort()
    } catch (error) {
      // workerd reports provider error 10024; S3-compatible test bindings may expose the symbolic code.
      if (
        error instanceof Error &&
        (error.name === 'NoSuchUpload' ||
          /\bNoSuchUpload\b|\(10024\)/.test(error.message))
      )
        return
      throw error
    }
  }
  async head(key: string) {
    keyPath(key)
    const object = await this.env.BUCKET.head(key)
    return object ? { size: object.size } : null
  }
  async remove(key: string) {
    keyPath(key)
    await this.env.BUCKET.delete(key)
  }
  download(key: string, expiresAtMs: number) {
    return this.presign(
      new URL(this.bucketUrl + '/' + keyPath(key)),
      'GET',
      expiresAtMs,
    )
  }

  /** Find orphaned uploads for one server-generated object key. Never return a partial inventory. */
  async discover(key: string) {
    keyPath(key)
    const result = new Set<string>(),
      markers = new Set<string>()
    const url = new URL(this.bucketUrl)
    url.searchParams.set('uploads', '')
    url.searchParams.set('prefix', key)
    url.searchParams.set('max-uploads', '100')
    for (let page = 0; page < pageLimit; page++) {
      const request = await this.signer.sign(url, {
        method: 'GET',
        redirect: 'error',
      })
      const xml = await controlXml(await this.http(request))
      const elements = /<Upload>([\s\S]*?)<\/Upload>/g
      const groups = [...xml.matchAll(elements)]
      const pageFields = xml.replace(elements, '')
      if (
        groups.length > 100 ||
        groups.length !== (xml.match(/<Upload\b/g) ?? []).length ||
        /<\/?(?:Upload|Key|UploadId)\b/.test(pageFields)
      )
        throw new Error('Invalid R2 multipart listing count.')
      for (const group of groups) {
        const item = group[1] ?? ''
        const candidate = xmlField(item, 'Key'),
          id = uploadIdentifier(xmlField(item, 'UploadId'))
        if (candidate === key) result.add(id)
      }
      const truncated = xmlField(pageFields, 'IsTruncated')
      if (truncated === 'false') return [...result]
      if (truncated !== 'true') throw new Error('Invalid R2 pagination flag.')
      const nextKey = xmlField(pageFields, 'NextKeyMarker'),
        nextId = uploadIdentifier(xmlField(pageFields, 'NextUploadIdMarker'))
      const marker = JSON.stringify([nextKey, nextId])
      if (!nextKey.startsWith(key) || markers.has(marker))
        throw new Error('Invalid R2 pagination cursor.')
      markers.add(marker)
      url.searchParams.set('key-marker', nextKey)
      url.searchParams.set('upload-id-marker', nextId)
    }
    throw new Error('R2 multipart recovery exceeded its page bound.')
  }
}
