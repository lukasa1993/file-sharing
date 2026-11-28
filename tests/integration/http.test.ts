import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, type Fixture } from '../fixture.ts'

describe('file server over real HTTP', () => {
  let f: Fixture
  let owner: Awaited<ReturnType<Fixture['signIn']>>
  beforeAll(async () => {
    f = await fixture()
    owner = await f.signIn()
  })
  afterAll(async () => {
    await f?.close()
  })
  const headers = () => ({ ...owner, 'Content-Type': 'application/json' })
  test('renders the native Remix file manager and serves its browser assets', async () => {
    const response = await f.fetch('/_/files?mount=e2e', { headers: owner })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('handoff.txt')
    for (const path of [
      'files.css',
      'files.js',
      'login-client.js',
      'hydrate-login.js',
    ]) {
      const asset = await f.fetch('/assets/' + path)
      expect(asset.status).toBe(200)
      expect((await asset.text()).length).toBeGreaterThan(20)
    }
  })
  test('a guest gets the original bytes and filename, including a resumed request', async () => {
    const ref = { mountId: 'e2e', segments: ['handoff.txt'] }
    const created = await f.fetch('/_/api/v1/shares', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        targets: [ref],
        alias: 'handoff',
        access: 'public',
        confirmPublic: true,
        mode: 'direct',
      }),
    })
    expect(created.status).toBe(201)
    const share = await created.json()
    const whole = await f.fetch('/handoff')
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-disposition')).toContain('handoff.txt')
    expect(await whole.text()).toBe('A real handoff\n')
    const part = await f.fetch('/handoff', {
      headers: {
        range: 'bytes=2-5',
        'if-range': whole.headers.get('etag') || '',
      },
    })
    expect(part.status).toBe(206)
    expect(await part.text()).toBe('real')
    expect(
      (
        await f.fetch('/_/api/v1/shares/' + share.id, {
          method: 'DELETE',
          headers: headers(),
        })
      ).status,
    ).toBe(204)
    expect((await f.fetch('/handoff')).status).toBe(404)
  })
  test('uploads publish an ordinary named file after the last chunk', async () => {
    const meta = (s: string) => Buffer.from(s).toString('base64')
    const protocol = { ...owner, 'Tus-Resumable': '1.0.0' }
    const created = await f.fetch('/_/uploads', {
      method: 'POST',
      headers: {
        ...protocol,
        'Upload-Length': '6',
        'Upload-Metadata': `mount ${meta('e2e')},filename ${meta('notes.txt')}`,
      },
    })
    expect(created.status).toBe(201)
    const path = created.headers.get('location')
    expect(created.headers.get('Fileserver-Max-Chunk-Bytes')).toBe(
      String(16 * 1024 * 1024),
    )
    if (!path) throw new Error('Missing upload URL')
    const patch = (offset: string, body: string) =>
      f.fetch(path, {
        method: 'PATCH',
        headers: {
          ...protocol,
          'Upload-Offset': offset,
          'Content-Type': 'application/offset+octet-stream',
        },
        body,
      })
    expect((await patch('0', 'abc')).status).toBe(204)
    expect(
      (await f.fetch(path, { method: 'HEAD', headers: protocol })).headers.get(
        'upload-offset',
      ),
    ).toBe('3')
    expect(await Bun.file(join(f.storage, 'notes.txt')).exists()).toBe(false)
    expect((await patch('3', 'def')).status).toBe(204)
    expect(await readFile(join(f.storage, 'notes.txt'), 'utf8')).toBe('abcdef')
  })
  test('externally added directories appear on refresh and preferences persist', async () => {
    await mkdir(join(f.storage, 'external'))
    await writeFile(join(f.storage, 'external', 'from-host.txt'), 'visible')
    const list = await f.fetch('/_/api/v1/entries?mount=e2e&path=external', {
      headers: owner,
    })
    expect(list.status).toBe(200)
    expect(await list.text()).toContain('from-host.txt')
    const prefs = await f.fetch('/_/api/v1/preferences', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        view: 'grid',
        theme: 'dark',
        favorite: { mountId: 'e2e', segments: ['external'] },
      }),
    })
    expect(prefs.status).toBe(200)
    expect((await prefs.json()).view).toBe('grid')
    const html = await (
      await f.fetch('/_/files?mount=e2e', { headers: owner })
    ).text()
    expect(html).toContain('data-theme="dark"')
    expect(html).toContain('data-display="grid"')
    const read = await f.fetch('/_/api/v1/preferences', { headers: owner })
    expect((await read.json()).favorites).toEqual([
      { mountId: 'e2e', segments: ['external'] },
    ])
  })
  test('admin status and health distinguish available mounts', async () => {
    for (const url of [
      '/healthz',
      '/readyz',
      '/_/admin',
      '/_/trash',
      '/_/account',
      '/_/shares',
    ]) {
      const r = await f.fetch(url, { headers: owner })
      expect(r.status).toBe(200)
      await r.arrayBuffer()
    }
  })
  test('only an administrator can export local runtime diagnostics', async () => {
    const path = '/_/api/v1/admin/diagnostics'
    expect((await f.fetch(path)).status).toBe(401)
    const response = await f.fetch(path, { headers: owner })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain('attachment')
    const report = await response.json()
    expect(report.bun).toBe(Bun.version)
    expect(report.residentBytes).toBeGreaterThan(0)
    expect(report.counters.requests).toBeGreaterThan(0)
    expect(JSON.stringify(report)).not.toContain(f.storage)
  })
  test('audit records correlate a failed request without storing its private URL', async () => {
    for (const [path, label] of [
      ['/private-link-name', 'public'],
      ['/_/unlisted-path', 'internal'],
      ['/_/api/v1/missing', '/_/api'],
    ] as const) {
      const response = await f.fetch(path + '?path=private-filename', {
        headers: owner,
      })
      expect(response.status).toBe(404)
      const row = f.app.services.meta
        .activity()
        .find((r) => r.request_id === response.headers.get('X-Request-ID'))
      expect(row?.operation).toBe(label)
      expect(JSON.stringify(row)).not.toContain('private-')
    }
  })
  test('audit labels keep known entry points and discard private path arguments', async () => {
    for (const [path, label] of [
      ['/', '/'],
      ['/login', '/login'],
      ['/logout', '/logout'],
      ['/readyz', '/readyz'],
      ['/healthz', '/healthz'],
      ['/_/files?path=private-notes', '/_/files'],
      ['/_/download?path=private-notes', '/_/download'],
      ['/_/files-extra', 'internal'],
      ['/private-notes', 'public'],
    ] as const) {
      const response = await f.fetch(path, {
        method: 'POST',
        headers: { origin: f.origin },
      })
      await response.body?.cancel()
      const event = f.app.services.meta
        .activity()
        .find(
          (item) => item.request_id === response.headers.get('X-Request-ID'),
        )
      expect(event?.operation).toBe(label)
      expect(JSON.stringify(event)).not.toContain('private-notes')
    }
  })
})
