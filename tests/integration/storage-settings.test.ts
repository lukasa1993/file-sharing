import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { fixture, type Fixture } from '../fixture.ts'

describe('storage and branding administration over HTTP', () => {
  let f: Fixture
  let owner: Awaited<ReturnType<Fixture['signIn']>>
  beforeAll(async () => {
    f = await fixture()
    owner = await f.signIn()
  })
  afterAll(async () => f?.close())

  function update(fields: Record<string, unknown>) {
    return f.fetch('/_/api/v1/admin', {
      method: 'POST',
      headers: { ...owner, 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    })
  }

  test('renames an existing root, takes it offline, and resumes access to the same files', async () => {
    const root = { action: 'setMount', mountId: 'e2e' }
    expect(
      (await update({ ...root, label: 'Shared library', enabled: false }))
        .status,
    ).toBe(200)
    const offline = await f.fetch('/_/files?mount=e2e', { headers: owner })
    expect(offline.status).toBe(503)
    expect(await offline.text()).toContain('Contact the host to reconnect')
    expect((await f.fetch('/readyz')).status).toBe(503)
    expect((await update({ ...root, enabled: true })).status).toBe(200)
    const online = await f.fetch('/_/files?mount=e2e', { headers: owner })
    expect(online.status).toBe(200)
    const html = await online.text()
    expect(html).toContain('Shared library')
    expect(html).toContain('handoff.txt')
    expect((await f.fetch('/readyz')).status).toBe(200)
  })

  test('rejects invalid administration changes before altering workspace settings', async () => {
    const root = { action: 'setMount', mountId: 'e2e' }
    for (const fields of [
      { ...root, mountId: 'missing' },
      { ...root, label: '' },
      { ...root, label: 25 },
      { ...root, label: 'x'.repeat(129) },
      { ...root, enabled: 'later' },
      ...[0, 3651, 1.5].map((retentionDays) => ({
        ...root,
        retentionDays,
        label: 'Wrong label',
      })),
      { action: 'setSettings', brand: 5 },
      { action: 'setSettings', brand: ' ' },
      { action: 'setSettings', brand: 'x'.repeat(61) },
      { action: 'setSettings', trashRetentionDays: 0 },
      { action: 'setHome', path: 'handoff.txt', mountId: 'e2e' },
    ])
      expect((await update(fields)).status).toBe(400)
    const html = await (
      await f.fetch('/_/files?mount=e2e', { headers: owner })
    ).text()
    expect(html).not.toContain('Wrong label')
    expect((await f.fetch('/readyz')).status).toBe(200)
  })

  test('uses the current workspace name and mark on a missing recipient page', async () => {
    expect(
      (await update({ action: 'setSettings', brand: 'Friends library' }))
        .status,
    ).toBe(200)
    const response = await f.fetch('/absent-recipient-file', {
      headers: { Accept: 'text/html' },
    })
    expect(response.status).toBe(404)
    const html = await response.text()
    expect(html).toContain('Friends library')
    expect(html).toContain('Link unavailable')
    const icon = await f.fetch('/assets/workspace-icon')
    expect(icon.headers.get('Content-Type')).toBe('image/png')
    const logo = await new Bun.Image(await icon.arrayBuffer()).metadata()
    expect(logo.format).toBe('png')
    expect(logo.width).toBe(logo.height)
  })
})
