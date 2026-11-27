import { expect, test } from 'bun:test'
import {
  createCloudWorker,
  type CloudEnvironment,
} from '../../cloudflare/worker.ts'

const origin = 'https://dl.ldev.cloud'
function fixture(reply = () => Response.json({ ok: true })) {
  const requests: Request[] = []
  const env = {
    PUBLIC_ORIGIN: origin,
    R2_ACCOUNT_ID: '1'.repeat(32),
    WORKSPACE: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (request: Request) => {
          requests.push(request)
          return reply()
        },
      }),
    },
    ASSETS: {
      fetch: () =>
        new Response('export default 1', {
          headers: { 'Content-Type': 'text/javascript' },
        }),
    },
  } as unknown as CloudEnvironment
  const worker = createCloudWorker()
  return {
    requests,
    env,
    send: (path: string, init?: RequestInit) =>
      worker.fetch(new Request(origin + path, init), env),
  }
}

test('only packaged assets and application shells are available outside the metadata API', async () => {
  const { send, requests } = fixture()
  for (const path of ['/', '/s/work', '/r/work']) {
    const page = await send(path)
    expect(page.status).toBe(200)
    expect(page.headers.get('Referrer-Policy')).toBe('same-origin')
    expect(page.headers.get('Content-Security-Policy')).toContain(
      "connect-src 'self' https://" +
        '1'.repeat(32) +
        '.r2.cloudflarestorage.com',
    )
    expect(await page.text()).toContain('lshare')
  }
  expect(await (await send('/', { method: 'HEAD' })).text()).toBe('')
  expect((await send('/assets/transfer-client.js')).status).toBe(200)
  for (const path of [
    '/internal/maintenance',
    '/assets/worker.ts',
    '/objects/foreign',
  ])
    expect((await send(path)).status).toBe(404)
  expect(requests).toHaveLength(0)
})

test('metadata boundary rejects byte transports, oversized metadata and foreign origins before the Durable Object', async () => {
  const { send, requests } = fixture()
  const path = '/api/transfers/uploads'
  const headers = { Origin: origin, 'Content-Type': 'application/json' }
  for (const method of ['PUT', 'PATCH'])
    expect((await send(path, { method, headers, body: 'data' })).status).toBe(
      405,
    )
  expect((await send(path, { method: 'POST', body: 'file' })).status).toBe(403)
  expect(
    (
      await send(path, {
        method: 'POST',
        headers: { ...headers, Origin: 'https://example.com' },
        body: '{}',
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await send(path, {
        method: 'POST',
        headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' },
        body: '{}',
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await send(path, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/octet-stream' },
        body: 'file',
      })
    ).status,
  ).toBe(415)
  expect(
    (await send(path, { method: 'POST', headers, body: 'x'.repeat(17 * 1024) }))
      .status,
  ).toBe(413)
  expect(
    (
      await send('/api/transfers/files/id', {
        method: 'DELETE',
        headers,
        body: 'x',
      })
    ).status,
  ).toBe(413)
  expect(requests).toHaveLength(0)
})

test('same-origin metadata and empty-body deletions reach the control plane', async () => {
  const { send, requests } = fixture()
  const headers = { Origin: origin, 'Content-Type': 'application/json' }
  const created = await send('/api/transfers/uploads', {
    method: 'POST',
    headers,
    body: '{"size":2}',
  })
  expect(await requests[0]?.json()).toEqual({ size: 2 })
  expect(created.headers.get('Cache-Control')).toBe('no-store')
  expect(created.headers.get('Referrer-Policy')).toBe('no-referrer')
  expect(
    (
      await send('/api/transfers/files/id', {
        method: 'DELETE',
        headers,
        body: '',
      })
    ).status,
  ).toBe(200)
  expect(requests[1]?.body).toBeNull()
  await send('/api/transfers/files/id/download')
  expect(requests.map((request) => request.redirect)).toEqual([
    'manual',
    'manual',
    'manual',
  ])
})

test('invalid deployment origins fail closed and fixture storage cannot be used on the public domain', async () => {
  const { env, requests } = fixture()
  expect(
    (
      await createCloudWorker().fetch(
        new Request('https://wrong.example/'),
        env,
      )
    ).status,
  ).toBe(421)
  expect(
    (
      await createCloudWorker('http://127.0.0.1:9000').fetch(
        new Request(origin + '/'),
        env,
      )
    ).status,
  ).toBe(503)
  expect(requests).toHaveLength(0)
})

test('storage redirects remain bodyless across the workerd service binding', async () => {
  const destination =
    'https://' + '1'.repeat(32) + '.r2.cloudflarestorage.com/bucket/file'
  const send = (reply: Response) =>
    fixture(() => reply).send('/api/transfers/files/id/download')
  const accepted = await send(
    new Response('', { status: 303, headers: { Location: destination } }),
  )
  expect(accepted.status).toBe(303)
  expect(accepted.headers.get('Location')).toBe(destination)
  expect(accepted.body).toBeNull()
  expect(
    (
      await send(
        new Response('bad', {
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      )
    ).status,
  ).toBe(502)
  expect(
    (
      await send(
        new Response(null, {
          status: 303,
          headers: { Location: 'https://foreign.example/' },
        }),
      )
    ).status,
  ).toBe(502)
})
