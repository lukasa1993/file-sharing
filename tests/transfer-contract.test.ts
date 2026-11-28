import { expect, test } from 'bun:test'
import {
  transferApi,
  partBytes,
  partLength,
  type TransferAdapter,
  type FileInfo,
} from '../shared/transfers.ts'

const file: FileInfo = {
  id: 'file-id',
  name: 'hello.txt',
  size: 2,
  expiresAt: null,
}
const adapter: TransferAdapter = {
  async create() {
    return { transport: 'multipart', id: 'upload-id', partSize: partBytes }
  },
  async part() {
    return 'https://storage.example/part'
  },
  async complete() {
    return file
  },
  async list() {
    return [file]
  },
  async download() {
    return 'https://storage.example/download'
  },
  async cancel() {
    return
  },
  async remove() {
    return
  },
}
const request = (path: string, method: string, body?: unknown) =>
  new Request('https://app.test/api/transfers/' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })

test('portable transfer metadata remains independent of the data plane', async () => {
  const result = await transferApi(
    request('uploads', 'POST', { name: 'hello.txt', size: 2 }),
    adapter,
  )
  expect(result.status).toBe(201)
  expect(await result.json()).toEqual({
    transport: 'multipart',
    id: 'upload-id',
    partSize: partBytes,
  })
  expect(
    await (await transferApi(request('files', 'GET'), adapter)).json(),
  ).toEqual({ files: [file] })
  expect(
    (
      await transferApi(request('files/file-id/download', 'GET'), adapter)
    ).headers.get('Location'),
  ).toBe('https://storage.example/download')
  for (const etag of ['opaque', '"opaque"'])
    expect(
      await (
        await transferApi(
          request('uploads/a/complete', 'POST', {
            parts: [{ partNumber: 1, etag }],
          }),
          adapter,
        )
      ).json(),
    ).toEqual(file)
})

test('metadata validation rejects malformed files and multipart receipts before dispatch', async () => {
  for (const data of [
    { name: 'folder/file', size: 0 },
    { name: 'file', size: -1 },
    { name: 'file', size: 1, body: 'bytes' },
    { name: 'file', size: 1, target: { mountId: 'x', segments: [false] } },
  ])
    await expect(
      transferApi(request('uploads', 'POST', data), adapter),
    ).rejects.toMatchObject({ status: 400 })
  for (const p of [
    [{ partNumber: 1, etag: '"broken' }],
    [{ partNumber: 1, etag: 'broken"' }],
    [{ partNumber: 2, etag: 'ok' }],
    null,
  ])
    await expect(
      transferApi(request('uploads/a/complete', 'POST', { parts: p }), adapter),
    ).rejects.toMatchObject({ status: 400 })
  expect(partLength(0, 1)).toBe(0)
  expect(partLength(partBytes + 1, 2)).toBe(1)
  expect(() => partLength(2, 2)).toThrow()
})
