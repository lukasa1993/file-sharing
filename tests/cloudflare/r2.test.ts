import { createHash, createHmac } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { ContentDisposition } from 'remix/headers'
import {
  R2Transfers,
  type R2ControlBinding,
  type R2Environment,
  type R2Part,
} from '../../cloudflare/r2.ts'

const now = Date.UTC(2026, 10, 28, 4, 5, 6, 789)
const env = (bucket: R2ControlBinding): R2Environment => ({
  BUCKET: bucket,
  R2_ACCOUNT_ID: 'a'.repeat(32),
  R2_BUCKET_NAME: 'shared-files',
  R2_ACCESS_KEY_ID: 'local-signing-key',
  R2_SECRET_ACCESS_KEY: 'synthetic-only-secret',
})
const binding: R2ControlBinding = {
  createMultipartUpload: async () => {
    throw new Error('unexpected create')
  },
  resumeMultipartUpload: () => {
    throw new Error('unexpected resume')
  },
  head: async () => null,
  delete: async () => {},
}
const resource = 'objects/one plus+百分#%'
const output = (body: string) =>
  new Response(body, { headers: { 'Content-Type': 'application/xml' } })
const list = (items: string, more = false, markers = '') =>
  '<?xml version="1.0" encoding="UTF-8"?><ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>' +
  more +
  '</IsTruncated>' +
  items +
  markers +
  '</ListMultipartUploadsResult>'
const item = (key: string, id: string) =>
  '<Upload><Key>' + key + '</Key><UploadId>' + id + '</UploadId></Upload>'

// Independent transport-side SigV4 check. The client passes only its generated
// entity length; it never knows the secret used to derive the signing key.
function signature(url: URL, method: string, size?: number) {
  const escape = (value: string) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
    )
  const query = [...url.searchParams]
    .filter(([key]) => key !== 'X-Amz-Signature')
    .map(([key, v]) => escape(key) + '=' + escape(v))
    .sort()
    .join('&')
  const headers = url.searchParams.get('X-Amz-SignedHeaders') || ''
  const canonicalHeaders =
    headers
      .split(';')
      .map((h) => h + ':' + (h === 'host' ? url.host : String(size)))
      .join('\n') + '\n'
  const path = url.pathname
    .split('/')
    .map((s) => escape(decodeURIComponent(s)))
    .join('/')
  const canonical = [
    method,
    path,
    query,
    canonicalHeaders,
    headers,
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const timestamp = url.searchParams.get('X-Amz-Date') || ''
  const scope = timestamp.slice(0, 8) + '/auto/s3/aws4_request'
  const payload = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n')
  let key = Buffer.from('AWS4' + env(binding).R2_SECRET_ACCESS_KEY)
  for (const component of scope.split('/'))
    key = Buffer.from(createHmac('sha256', key).update(component).digest())
  return createHmac('sha256', key).update(payload).digest('hex')
}

describe('direct R2 transfers', () => {
  test('the signed UploadPart fixes method, key, upload, part number and exact Blob length', async () => {
    const r2 = new R2Transfers(env(binding), { now: () => now })
    const url = new URL(
      await r2.part(resource, 'session+/%=', 2, 51537, now + 100_000),
    )
    expect(url.hostname).toBe('a'.repeat(32) + '.r2.cloudflarestorage.com')
    expect(decodeURIComponent(url.pathname)).toBe('/shared-files/' + resource)
    expect(url.searchParams.get('uploadId')).toBe('session+/%=')
    expect(url.searchParams.get('partNumber')).toBe('2')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;host',
    )
    const signed = url.searchParams.get('X-Amz-Signature')
    expect(signed).toBe(signature(url, 'PUT', 51537))
    expect(signed).not.toBe(signature(url, 'PUT', 51538))
    expect(signed).not.toBe(signature(url, 'GET', 51537))
    url.searchParams.set('partNumber', '3')
    expect(signed).not.toBe(signature(url, 'PUT', 51537))
    url.searchParams.set('partNumber', '2')
    url.searchParams.delete('uploadId')
    expect(signed).not.toBe(signature(url, 'PUT', 51537))
    expect(url.href).not.toContain(env(binding).R2_SECRET_ACCESS_KEY)
    const empty = new URL(
      await r2.part(resource, 'empty-session', 1, 0, now + 10_000),
    )
    expect(empty.searchParams.get('X-Amz-Signature')).toBe(
      signature(empty, 'PUT', 0),
    )
  })

  test('signed GET leaves Range available and clamps expiration at the preceding whole second', async () => {
    const service = new R2Transfers(
      { ...env(binding), R2_JURISDICTION: 'eu' },
      { now: () => now },
    )
    const url = new URL(await service.download(resource, now + 1599))
    expect(url.hostname).toBe('a'.repeat(32) + '.eu.r2.cloudflarestorage.com')
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261128T040506Z')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('2')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(url.searchParams.get('X-Amz-Signature')).toBe(signature(url, 'GET'))
    expect(
      new URL(
        await service.download(resource, now + 10 * 60 * 60 * 1000),
      ).searchParams.get('X-Amz-Expires'),
    ).toBe('900')
    for (const deadline of [now - 1, now + 100, NaN, Infinity])
      await expect(service.download(resource, deadline)).rejects.toThrow(
        'expired',
      )
  })

  test('the native control calls preserve an attachment name and pass bare provider ETags', async () => {
    const calls: string[] = []
    let meta:
      | {
          contentType: string
          contentDisposition: string
          cacheControl: string
        }
      | undefined
    let published: R2Part[] = []
    const upload = {
      uploadId: 'abc+/',
      complete: async (parts: R2Part[]) => {
        published = parts
        calls.push('complete')
      },
      abort: async () => {
        calls.push('abort')
      },
    }
    const storage: R2ControlBinding = {
      createMultipartUpload: async (key, option) => {
        calls.push('create:' + key)
        meta = option.httpMetadata
        return upload
      },
      resumeMultipartUpload: (key, id) => {
        calls.push('resume:' + key + ':' + id)
        return upload
      },
      head: async (key) => {
        calls.push('head:' + key)
        return { size: 13 }
      },
      delete: async (key) => {
        calls.push('delete:' + key)
      },
    }
    const service = new R2Transfers(env(storage))
    const name = 'résumé #%.txt'
    const id = await service.create(resource, name)
    expect(
      ContentDisposition.from(meta?.contentDisposition ?? null)
        .preferredFilename,
    ).toBe(name)
    expect(meta?.contentType).toBe('application/octet-stream')
    expect(meta?.cacheControl).toBe('private, no-store, no-transform')
    await service.complete(resource, id, [
      { partNumber: 2, etag: '"two"' },
      { partNumber: 1, etag: 'one' },
    ])
    expect(published).toEqual([
      { partNumber: 1, etag: 'one' },
      { partNumber: 2, etag: 'two' },
    ])
    await service.abort(resource, id)
    expect(await service.head(resource)).toEqual({ size: 13 })
    expect(await new R2Transfers(env(binding)).head(resource)).toBeNull()
    await service.remove(resource)
    expect(calls).toEqual([
      'create:' + resource,
      'resume:' + resource + ':' + id,
      'complete',
      'resume:' + resource + ':' + id,
      'abort',
      'head:' + resource,
      'delete:' + resource,
    ])
  })

  test('validates local provider overrides and multipart boundaries before any write', async () => {
    const service = new R2Transfers(env(binding), {
      endpoint: 'http://127.0.0.1:9000',
      now: () => now,
    })
    expect(
      new URL(await service.download('files/demo', now + 60_000)).origin,
    ).toBe('http://127.0.0.1:9000')
    for (const endpoint of [
      'http://example.com',
      'https://127.0.0.1',
      'http://127.0.0.1/elsewhere',
      'http://user@127.0.0.1',
      'http://127.0.0.1/?a=b',
    ])
      expect(() => new R2Transfers(env(binding), { endpoint })).toThrow()
    for (const key of ['', 'a/../b', '/a', 'a//b', 'x\\y'])
      await expect(service.create(key, 'sample')).rejects.toThrow('object key')
    await expect(service.create('valid', 'not/a-file')).rejects.toThrow(
      'filename',
    )
    for (const n of [0, 10001, 1.25])
      expect(() => service.part('valid', 'id', n, 4, now + 10_000)).toThrow()
    for (const length of [-1, 2.5, 5 * 1024 ** 3])
      expect(() =>
        service.part('valid', 'id', 1, length, now + 10_000),
      ).toThrow()
    for (const parts of [
      [],
      [{ partNumber: 2, etag: 'two' }],
      [{ partNumber: 1, etag: '"broken' }],
      [
        { partNumber: 1, etag: 'one' },
        { partNumber: 1, etag: 'two' },
      ],
    ])
      await expect(service.complete('valid', 'id', parts)).rejects.toThrow()
  })

  test('recovery pages through an exact-key inventory and decodes provider XML escapes', async () => {
    const requests: Request[] = []
    const key = 'objects/a&b'
    const service = new R2Transfers(env(binding), {
      fetch: async (request) => {
        requests.push(request)
        return requests.length === 1
          ? output(
              list(
                item('objects/a&amp;b', 'upload&amp;1') +
                  item('objects/a&amp;b-extra', 'ignored'),
                true,
                '<NextKeyMarker>objects/a&amp;b</NextKeyMarker><NextUploadIdMarker>upload&amp;1</NextUploadIdMarker>',
              ),
            )
          : output(list(item('objects/a&#38;b', 'upload-2')))
      },
    })
    expect(await service.discover(key)).toEqual(['upload&1', 'upload-2'])
    expect(requests.length).toBe(2)
    for (const request of requests) {
      expect(request.method).toBe('GET')
      const url = new URL(request.url)
      expect(url.pathname).toBe('/shared-files')
      expect(url.searchParams.get('prefix')).toBe(key)
      expect(url.searchParams.has('uploads')).toBe(true)
      expect(url.searchParams.has('X-Amz-Signature')).toBe(false)
      expect(request.headers.get('Authorization')).toStartWith(
        'AWS4-HMAC-SHA256 ',
      )
      expect(request.redirect).toBe('error')
    }
    expect(
      new URL(requests[1]?.url ?? '').searchParams.get('upload-id-marker'),
    ).toBe('upload&1')
  })
  test('refuses partial, repeated, out-of-bound or unavailable recovery inventories', async () => {
    const markers =
      '<NextKeyMarker>objects/x</NextKeyMarker><NextUploadIdMarker>same</NextUploadIdMarker>'
    for (const get of [
      () => new Response('unavailable', { status: 503 }),
      () => output(list('<Upload><Key>objects/x</Key></Upload>')),
      () => output(list('<Upload/>')),
      () => output(list('<Key>objects/x</Key><UploadId>x</UploadId>')),
      () => output(list('</Upload>')),
      () => output(list(item('objects/x', 'x'), true)),
      () => output(list(item('objects/x', 'x'), true, markers)),
      () => output('x'.repeat(513 * 1024)),
      () => output(list('').replace('false', 'maybe')),
      () => output('<!DOCTYPE ignored>' + list('')),
      () => output(list(item('objects/x', 'bad&bogus;'))),
    ]) {
      const service = new R2Transfers(env(binding), {
        fetch: async () => get(),
      })
      await expect(service.discover('objects/x')).rejects.toThrow()
    }
    let calls = 0
    const service = new R2Transfers(env(binding), {
      fetch: async () =>
        output(list('', true, markers.replace('same', String(++calls)))),
    })
    await expect(service.discover('objects/x')).rejects.toThrow('page bound')
    expect(calls).toBe(4)
  })
  test('aborting an already-consumed provider ID is idempotent, other errors propagate', async () => {
    let problem =
      'abortMultipartUpload: The specified multipart upload does not exist. (10024)'
    const service = new R2Transfers(
      env({
        ...binding,
        resumeMultipartUpload: () => ({
          uploadId: 'id',
          complete: async () => {},
          abort: async () => {
            throw new Error(problem)
          },
        }),
      }),
    )
    await service.abort('objects/x', 'id')
    problem = 'Storage unavailable'
    await expect(service.abort('objects/x', 'id')).rejects.toThrow(problem)
  })
})
