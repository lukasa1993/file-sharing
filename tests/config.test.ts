import { expect, test } from 'bun:test'
import { Effect, Random } from 'effect'
import { trustedProxyPeers } from '../app/proxy.ts'
import { localNext } from '../app/http.ts'
import { requestRef, resource } from '../app/metadata.ts'
import { refUrl } from '../app/ui/base.tsx'
import { listenHttp } from '../app/transport.ts'

test('uses the connected peer unless the host explicitly trusts a proxy', () => {
  const resolve = trustedProxyPeers(['10.1.0.0/16'])
  const request = new Request('http://localhost/', {
    headers: { 'X-Forwarded-For': '192.0.2.8, 10.1.0.4' },
  })
  expect(resolve('127.0.0.1', request)).toBe('127.0.0.1')
  expect(resolve('10.1.0.3', request)).toBe('192.0.2.8')
  expect(() => trustedProxyPeers(['invalid'])).toThrow()
})
test('returns login redirects within the application', () => {
  expect(localNext('/_/files?mount=home')).toBe('/_/files?mount=home')
  expect(localNext('https://example.test')).toBe('/')
  expect(localNext('//example.test')).toBe('/')
})

test('constructs the canonical HTTPS URL behind a TLS terminator using the supplied host', async () => {
  const server = await listenHttp(
    { hostname: '127.0.0.1', port: 0, publicProtocol: 'https:' },
    (req) => new Response(req.url),
  )
  try {
    const response = await fetch(new URL('/login', server.url), {
      headers: {
        Host: 'files.example:80',
        'X-Forwarded-Proto': 'http',
        'X-Forwarded-Host': 'unused.example',
      },
    })
    expect(await response.text()).toBe('https://files.example:80/login')
  } finally {
    await server.stop(true)
  }
})
test('preserves valid Unicode and literal percent signs in storage references', () => {
  expect(
    resource({ mountId: 'home', segments: ['სამუშაო 50%', 'note.txt'] }),
  ).toEqual({ mountId: 'home', segments: ['სამუშაო 50%', 'note.txt'] })
  expect(() => resource({ mountId: 'home', segments: [''] })).toThrow()
})

test('file-manager links round-trip generated paths without changing their folder boundaries', async () => {
  const symbols = [
    'a',
    'Z',
    'ñ',
    'ე',
    '一',
    '📁',
    ' ',
    '%',
    '+',
    '#',
    '?',
    '&',
    '.',
    '-',
  ] as const
  const names = Effect.gen(function* () {
    let name = 'file'
    const length = yield* Random.nextIntBetween(1, 18)
    for (let i = 0; i < length; i++) name += yield* Random.choice(symbols)
    return name
  })
  const check = Effect.gen(function* () {
    for (let sample = 0; sample < 200; sample++) {
      const depth = yield* Random.nextIntBetween(0, 6)
      const segments = yield* Effect.all(
        Array.from({ length: depth }, () => names),
      )
      const ref = { mountId: 'home', segments }
      const url = new URL(refUrl('/_/files', ref), 'http://localhost')
      expect(requestRef(url)).toEqual(ref)
    }
  })
  await Effect.runPromise(
    check.pipe(Random.withSeed('fileserver-ref-roundtrip')),
  )
})
