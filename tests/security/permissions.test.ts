import { afterAll, beforeAll, expect, test } from 'bun:test'
import { fixture, type Fixture } from '../fixture.ts'
let f: Fixture
beforeAll(async () => {
  f = await fixture()
})
afterAll(async () => {
  await f?.close()
})
test('private listings and file content require a session on every request', async () => {
  for (const url of [
    '/_/api/v1/entries?mount=e2e',
    '/_/download?mount=e2e&path=handoff.txt',
    '/_/preview?mount=e2e&path=handoff.txt',
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await f.fetch(url, { method })
      expect(response.status).toBe(401)
      expect(await response.text()).not.toContain('A real handoff')
    }
  }
})
test('cookie-authenticated changes require the session CSRF token', async () => {
  const owner = await f.signIn()
  const response = await f.fetch('/_/api/v1/preferences', {
    method: 'POST',
    headers: {
      cookie: owner.cookie,
      origin: f.origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ view: 'grid' }),
  })
  expect(response.status).toBe(403)
})
test('logout invalidates the old cookie and keeps private response headers', async () => {
  const owner = await f.signIn()
  expect(
    (await f.fetch('/logout', { method: 'POST', headers: owner })).status,
  ).toBe(303)
  const expired = await f.fetch('/_/api/v1/entries?mount=e2e', {
    headers: { cookie: owner.cookie },
  })
  expect(expired.status).toBe(401)
  expect(expired.headers.get('cache-control')).toContain('no-store')
  expect(expired.headers.get('x-content-type-options')).toBe('nosniff')
  expect(expired.headers.get('content-security-policy')).toContain(
    "object-src 'none'",
  )
})
