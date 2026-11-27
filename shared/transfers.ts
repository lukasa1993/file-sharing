import { AppError } from '../app/contracts.ts'
export { AppError as TransferError }
export type FileInfo = {
  id: string
  name: string
  size: number
  expiresAt: number | null
}
export type TransferTarget = { mountId: string; segments: string[] }
export type UploadInput = {
  name: string
  size: number
  target?: TransferTarget
  requestAlias?: string
  idempotencyKey?: string
}
export type UploadSession =
  | { transport: 'multipart'; id: string; partSize: number }
  | { transport: 'tus'; id: string; url: string; chunkSize: number }
export type Part = { partNumber: number; etag: string }
export interface TransferAdapter {
  create(input: UploadInput): Promise<UploadSession>
  part(id: string, partNumber: number): Promise<string>
  complete(id: string, parts: Part[]): Promise<FileInfo>
  cancel(id: string): Promise<void>
  list(
    url: URL,
  ): Promise<FileInfo[] | { files: FileInfo[]; nextCursor: string | null }>
  download(id: string): Promise<string>
  remove(id: string): Promise<void>
}

export const partBytes = 8 * 1024 * 1024
export const partCount = (size: number) =>
  Math.max(1, Math.ceil(size / partBytes))
export function partLength(size: number, number: number) {
  if (!Number.isSafeInteger(number) || number < 1 || number > partCount(size))
    throw new AppError(400, 'Invalid part number')
  return Math.min(partBytes, size - (number - 1) * partBytes)
}

export async function controlText(request: Request, limit = 16 * 1024) {
  if (Number(request.headers.get('Content-Length')) > limit)
    throw new AppError(413, 'Metadata too large')
  const reader = request.body?.getReader()
  if (!reader) return ''
  let bytes = 0,
    value = ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return value + decoder.decode()
      bytes += chunk.value.length
      if (bytes > limit) throw new AppError(413, 'Metadata too large')
      value += decoder.decode(chunk.value, { stream: true })
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (error instanceof AppError) throw error
    throw new AppError(400, 'Invalid metadata')
  } finally {
    reader.releaseLock()
  }
}
export async function controlJson(
  request: Request,
): Promise<Record<string, unknown>> {
  if (
    request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !==
    'application/json'
  )
    throw new AppError(415, 'Expected JSON metadata')
  let body: unknown
  const value = await controlText(request)
  try {
    body = JSON.parse(value)
  } catch {
    throw new AppError(400, 'Invalid JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new AppError(400, 'Expected a JSON object')
  return body as Record<string, unknown>
}

function input(body: Record<string, unknown>): UploadInput {
  if (
    Object.keys(body).some(
      (key) =>
        !['name', 'size', 'target', 'requestAlias', 'idempotencyKey'].includes(
          key,
        ),
    )
  )
    throw new AppError(400, 'Unknown upload metadata')
  const { name, size, target, requestAlias, idempotencyKey } = body
  if (
    typeof name !== 'string' ||
    !name ||
    name === '.' ||
    name === '..' ||
    /[\/\\\x00-\x1f\x7f]/.test(name) ||
    !name.isWellFormed() ||
    new TextEncoder().encode(name).length > 255
  )
    throw new AppError(400, 'Invalid filename')
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
    throw new AppError(400, 'Invalid file size')
  const parsed: UploadInput = { name, size }
  if (target !== undefined) {
    const t = target as TransferTarget | null
    if (
      !t ||
      typeof t.mountId !== 'string' ||
      !Array.isArray(t.segments) ||
      !t.segments.every((s) => typeof s === 'string')
    )
      throw new AppError(400, 'Invalid upload folder')
    parsed.target = { mountId: t.mountId, segments: t.segments }
  }
  if (requestAlias !== undefined) {
    if (
      typeof requestAlias !== 'string' ||
      !requestAlias ||
      requestAlias.length > 256 ||
      target !== undefined
    )
      throw new AppError(400, 'Invalid request link')
    parsed.requestAlias = requestAlias
  }
  if (idempotencyKey !== undefined) {
    if (
      typeof idempotencyKey !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(idempotencyKey)
    )
      throw new AppError(400, 'Invalid upload key')
    parsed.idempotencyKey = idempotencyKey
  }
  return parsed
}
function parts(value: unknown): Part[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new AppError(400, 'Invalid upload parts')
  return value.map((p: unknown, i) => {
    const part = p as Part | null
    if (
      !part ||
      part.partNumber !== i + 1 ||
      typeof part.etag !== 'string' ||
      !/^(?:"[\x21\x23-\x7e]{1,1024}"|[\x21\x23-\x7e]{1,1024})$/.test(part.etag)
    )
      throw new AppError(400, 'Invalid upload part')
    return { partNumber: i + 1, etag: part.etag }
  })
}

export async function transferApi(request: Request, adapter: TransferAdapter) {
  const url = new URL(request.url)
  const path = url.pathname.slice('/api/transfers/'.length).split('/')
  const [kind, id, action] = path
  const method = request.method
  if (kind === 'uploads' && path.length === 1 && method === 'POST')
    return Response.json(
      await adapter.create(input(await controlJson(request))),
      { status: 201 },
    )
  if (kind === 'files' && path.length === 1 && method === 'GET') {
    const page = await adapter.list(url)
    return Response.json(Array.isArray(page) ? { files: page } : page)
  }
  if (
    !id ||
    id.length > 8192 ||
    !/^[A-Za-z0-9_-]+$/.test(id) ||
    path.length > 3
  )
    throw new AppError(404, 'Transfer route not found')
  if (kind === 'uploads' && action === 'parts' && method === 'POST') {
    const number = (await controlJson(request)).partNumber
    if (
      typeof number !== 'number' ||
      !Number.isSafeInteger(number) ||
      number < 1
    )
      throw new AppError(400, 'Invalid part number')
    return Response.json({
      method: 'PUT',
      url: await adapter.part(id, number),
      headers: {},
    })
  }
  if (kind === 'uploads' && action === 'complete' && method === 'POST')
    return Response.json(
      await adapter.complete(id, parts((await controlJson(request)).parts)),
    )
  if (
    (kind === 'uploads' || kind === 'files') &&
    path.length === 2 &&
    method === 'DELETE'
  ) {
    if (kind === 'uploads') await adapter.cancel(id)
    else await adapter.remove(id)
    return new Response(null, { status: 204 })
  }
  if (kind === 'files' && action === 'download' && method === 'GET')
    return new Response(null, {
      status: 303,
      headers: {
        Location: await adapter.download(id),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    })
  throw new AppError(404, 'Transfer route not found')
}
