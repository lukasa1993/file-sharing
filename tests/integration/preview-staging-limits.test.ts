import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createApp } from '../../app/application.ts'
import { loadConfig } from '../../app/config.ts'
import { defaultContentLimits } from '../../app/transfers/content-limits.ts'
import { fixture, type Fixture } from '../fixture.ts'

describe('workspace preview and staging limits over HTTP', () => {
  let f: Fixture
  let owner: Awaited<ReturnType<Fixture['signIn']>>
  beforeAll(async () => {
    f = await fixture()
    owner = await f.signIn()
  }, 60_000)
  afterEach(() =>
    f?.app.services.transfers.contentPolicy.update(defaultContentLimits),
  )
  afterAll(async () => f?.close(), 30_000)

  function update(
    fields: Record<string, unknown>,
    headers: HeadersInit = owner,
  ) {
    return f.fetch('/_/api/v1/admin', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'setContentLimits', ...fields }),
    })
  }
  test('loads defaults on a prior database and persists only a complete authorized, valid revision', async () => {
    expect(f.app.services.transfers.contentPolicy.current).toEqual(
      defaultContentLimits,
    )
    expect(
      (
        await update(
          { imagePixels: 1 },
          { cookie: owner.cookie, origin: owner.origin },
        )
      ).status,
    ).toBe(403)
    expect((await update({ imagePixels: 1 }, {})).ok).toBe(false)
    for (const fields of [
      {},
      { textPreviewKiB: null },
      { maxUploadBytes: -1 },
      { imageInputMiB: 17, imagePixels: 1 },
      { textPreviewKiB: 1.5 },
      { inspectionKiB: '1e2' },
      { imagePixels: true },
      { maxStagingBytes: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect((await update(fields)).status).toBe(400)
    }
    expect(f.app.services.transfers.contentPolicy.current).toEqual(
      defaultContentLimits,
    )
    expect(
      (
        await update({
          imageInputMiB: '2',
          textPreviewKiB: 32,
          maxUploadBytes: 140 * 1024 ** 3,
        })
      ).ok,
    ).toBe(true)
    const second = await createApp(loadConfig(f.env))
    try {
      expect(second.services.transfers.contentPolicy.current).toEqual({
        ...defaultContentLimits,
        imageInputMiB: 2,
        textPreviewKiB: 32,
        maxUploadBytes: 140 * 1024 ** 3,
      })
    } finally {
      await second.close()
    }
  }, 30_000)
  test('applies text, inspection, image input and pixel limits to previews, edits and cached thumbnails', async () => {
    const source = 'z'.repeat(2048) + 'END_MARKER'
    await writeFile(join(f.storage, 'note.md'), source)
    const tiny = Buffer.from(
      'R0lGODdhAgACAIEAAP///wAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7',
      'base64',
    )
    await writeFile(join(f.storage, 'tiny.gif'), tiny)
    // A valid, uncompressed 1024 × 400 RGB BMP requires more than 1 MiB of input.
    const large = Buffer.alloc(54 + 1024 * 400 * 3)
    large.write('BM')
    large.writeUInt32LE(large.length, 2)
    large.writeUInt32LE(54, 10)
    large.writeUInt32LE(40, 14)
    large.writeInt32LE(1024, 18)
    large.writeInt32LE(400, 22)
    large.writeUInt16LE(1, 26)
    large.writeUInt16LE(24, 28)
    await writeFile(join(f.storage, 'large.bmp'), large)
    const get = (route: string, name: string, extra = '') =>
      f.fetch('/_/' + route + '?mount=e2e&path=' + name + extra, {
        headers: owner,
      })
    for (const name of ['tiny.gif', 'large.bmp']) {
      const response = await get('preview', name, '&thumbnail=1')
      expect(response.headers.get('content-type')).toBe('image/webp')
      await response.arrayBuffer()
    }
    expect(
      (
        await update({
          imagePixels: 3,
          imageInputMiB: 1,
          textPreviewKiB: 2,
          inspectionKiB: 1,
        })
      ).ok,
    ).toBe(true)
    for (const name of ['tiny.gif', 'large.bmp']) {
      const denied = await get('preview', name, '&thumbnail=1')
      expect(denied.status).toBe(415)
      expect((await denied.arrayBuffer()).byteLength).toBe(0)
      const original = await get('download', name)
      expect(
        Buffer.from(await original.arrayBuffer()).equals(
          name === 'tiny.gif' ? tiny : large,
        ),
      ).toBe(true)
    }
    expect((await update({ imagePixels: 1_000_000 })).ok).toBe(true)
    const oversized = await get('preview', 'large.bmp', '&thumbnail=1')
    expect(oversized.status).toBe(415)
    expect((await oversized.arrayBuffer()).byteLength).toBe(0)
    const preview = await get('preview', 'note.md')
    const version = preview.headers.get('X-File-Version')
    expect(preview.headers.get('X-Preview-Truncated')).toBe('true')
    expect(await preview.text()).toBe('z'.repeat(2048))
    const formatted = await (await get('inspect', 'note.md')).text()
    expect(formatted).toContain('first 1 KiB')
    expect(formatted).not.toContain('z'.repeat(1025))
    expect(
      (
        await f.fetch('/_/preview?mount=e2e&path=note.md', {
          method: 'PUT',
          headers: {
            ...owner,
            'Content-Type': 'text/plain',
            'If-Match': '"' + version + '"',
          },
          body: 'short',
        })
      ).status,
    ).toBe(413)
    expect(await (await get('download', 'note.md')).text()).toBe(source)
    expect((await update({ textPreviewKiB: 1, inspectionKiB: 128 })).ok).toBe(
      true,
    )
    expect(await (await get('inspect', 'note.md')).text()).toContain(
      'first 1 KiB',
    )
  }, 30_000)
  test('the archive member cap applies to both previews while original TAR bytes remain available', async () => {
    const bytes = await new Bun.Archive({
      'one.txt': 'one',
      'two.txt': 'two',
    }).bytes()
    await writeFile(join(f.storage, 'items.tar'), bytes)
    const get = (action: string) =>
      f.fetch('/_/' + action + '?mount=e2e&path=items.tar', { headers: owner })
    expect(await (await get('preview')).text()).toContain('two.txt')
    expect((await update({ archivePreviewEntries: 1 })).ok).toBe(true)
    const fallback = await get('preview')
    expect(fallback.headers.get('content-disposition')).toStartWith(
      'attachment',
    )
    expect(Buffer.from(await fallback.arrayBuffer()).equals(bytes)).toBe(true)
    const inspection = await get('inspect')
    expect(inspection.status).toBe(415)
    expect(await inspection.text()).toContain('Too many archive entries')
  }, 30_000)
  test('accepts permitted edits above the previous 256 KiB body limit and rejects the first byte beyond a lowered limit', async () => {
    await writeFile(join(f.storage, 'edit.txt'), 'start')
    const url = '/_/preview?mount=e2e&path=edit.txt'
    const version = async () =>
      (await f.fetch(url, { method: 'HEAD', headers: owner })).headers.get(
        'x-file-version',
      )
    const edit = async (data: string) =>
      f.fetch(url, {
        method: 'PUT',
        headers: {
          ...owner,
          'Content-Type': 'text/plain',
          'If-Match': '"' + (await version()) + '"',
        },
        body: data,
      })
    await update({ textPreviewKiB: 300 })
    const content = 'x'.repeat(300 * 1024)
    expect((await edit(content)).status).toBe(204)
    expect(await readFile(join(f.storage, 'edit.txt'), 'utf8')).toBe(content)
    await update({ textPreviewKiB: 1 })
    await writeFile(join(f.storage, 'edit.txt'), 'small')
    expect((await edit('y'.repeat(1025))).status).toBe(413)
    expect(await readFile(join(f.storage, 'edit.txt'), 'utf8')).toBe('small')
  }, 30_000)
  test('charges the entire upload declaration across owner and share scopes until completion or cancellation', async () => {
    await mkdir(join(f.storage, 'drop'))
    const share = await f.fetch('/_/api/v1/shares', {
      method: 'POST',
      headers: { ...owner, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'upload',
        targets: [{ mountId: 'e2e', segments: ['drop'] }],
        access: 'public',
        confirmPublic: true,
      }),
    })
    expect(share.status).toBe(201)
    const { alias } = (await share.json()) as { alias: string }
    const protocol = { ...owner, 'Tus-Resumable': '1.0.0' }
    const create = (filename: string, bytes: number, publicShare = false) =>
      f.fetch('/_/uploads' + (publicShare ? '?share=' + alias : ''), {
        method: 'POST',
        headers: {
          ...protocol,
          'Upload-Length': String(bytes),
          'Upload-Metadata':
            'mount ZTJl,filename ' + Buffer.from(filename).toString('base64'),
        },
      })
    const patch = (url: string, at: number, data: string) =>
      f.fetch(url, {
        method: 'PATCH',
        headers: {
          ...protocol,
          'Content-Type': 'application/offset+octet-stream',
          'Upload-Offset': String(at),
        },
        body: data,
      })
    expect((await update({ maxStagingBytes: 5, maxUploadBytes: 4 })).ok).toBe(
      true,
    )
    expect((await create('large', 5, true)).status).toBe(413)
    const ownerUpload = await create('exact', 4)
    expect(ownerUpload.status).toBe(201)
    const url = ownerUpload.headers.get('Location') || ''
    expect((await patch(url, 0, 'ab')).status).toBe(204)
    expect((await create('wait', 2, true)).status).toBe(507)
    const shared = await create('fits', 1, true)
    expect(shared.status).toBe(201)
    const sharedUrl = shared.headers.get('Location') || ''
    expect(
      (await f.fetch(sharedUrl, { method: 'DELETE', headers: protocol }))
        .status,
    ).toBe(204)
    expect((await update({ maxStagingBytes: 1, maxUploadBytes: 1 })).ok).toBe(
      true,
    )
    expect((await patch(url, 2, 'cd')).status).toBe(204)
    expect(await readFile(join(f.storage, 'exact'), 'utf8')).toBe('abcd')
    const available = await create('next', 1, true)
    expect(available.status).toBe(201)
    expect(
      (await patch(available.headers.get('Location') || '', 0, 'x')).status,
    ).toBe(204)
    expect(await readFile(join(f.storage, 'drop', 'next'), 'utf8')).toBe('x')
    await update({ maxStagingBytes: 5, maxUploadBytes: 0 })
    const competing = await Promise.all([
      create('concurrent-a', 4),
      create('concurrent-b', 4, true),
    ])
    expect(competing.map((response) => response.status).sort()).toEqual([
      201, 507,
    ])
    await update({ maxStagingBytes: 1 })
    expect((await create('empty', 0)).status).toBe(201)
  }, 30_000)
})
