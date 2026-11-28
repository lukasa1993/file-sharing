import { expect, spyOn, test } from 'bun:test'
import { createServer, request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listenHttp } from '../app/transport.ts'
import { initialize } from '../scripts/ops.ts'

test('the real server releases an occupied startup attempt and then handles SIGINT on its default loopback listener', async () => {
  const state = await mkdtemp(join(tmpdir(), 'fileserver-boot-boundary-'))
  const box = join(state, 'state')
  const occupied = createServer()
  let started: ReturnType<typeof Bun.spawn> | undefined
  try {
    await initialize(box, 'owner')
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '127.0.0.1', resolve)
    })
    const address = occupied.address()
    if (!address || typeof address === 'string')
      throw new Error('Expected listening TCP port')
    const config = join(box, 'config')
    const env = {
      PATH: process.env.PATH,
      PUBLIC_ORIGIN: 'http://127.0.0.1:' + address.port,
      PORT: String(address.port),
      CONFIG_FILE: join(config, 'mounts.json'),
      SESSION_SECRET_FILE: join(config, 'session.key'),
      BOOTSTRAP_FILE: join(config, 'bootstrap.json'),
      DATA_DIR: join(box, 'data'),
    }
    const invoke = (mode: string) =>
      Bun.spawn([process.execPath, join(import.meta.dir, '../server.ts')], {
        env: { ...env, NODE_ENV: mode },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 20000,
      })
    const blocked = invoke('production')
    expect(await blocked.exited).toBe(1)
    const failure = JSON.parse(
      (await new Response(blocked.stderr).text()).trim().split('\n').at(-1) ??
        '{}',
    )
    expect(failure.event).toBe('startup.failed')
    expect(failure.message).toMatch(
      /already in use|EADDRINUSE|port \d+ in use/i,
    )
    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error ? reject(error) : resolve())),
    )
    const running = invoke('test')
    started = running
    const output = running.stdout.getReader()
    try {
      const first = await output.read()
      expect(new TextDecoder().decode(first.value)).toContain(
        '"event":"server.ready"',
      )
    } finally {
      output.releaseLock()
    }
    const ready = await fetch(env.PUBLIC_ORIGIN + '/readyz', {
      signal: AbortSignal.timeout(3000),
    })
    expect(ready.status).toBe(200)
    expect(await ready.json()).toEqual({ status: 'ready' })
    running.kill('SIGINT')
    expect(await running.exited).toBe(0)
    let stopped = ''
    for await (const chunk of running.stdout)
      stopped += new TextDecoder().decode(chunk)
    expect(stopped).toContain('"event":"server.stopped"')
  } finally {
    if (started && started.exitCode === null) {
      started.kill('SIGKILL')
      await started.exited
    }
    if (occupied.listening)
      await new Promise<void>((resolve) => occupied.close(() => resolve()))
    await rm(state, { recursive: true, force: true })
  }
}, 40000)

test('the HTTP adapter rejects an oversized declared body at the header boundary', async () => {
  let dispatched = 0
  const server = await listenHttp({ hostname: '127.0.0.1', port: 0 }, () => {
    dispatched++
    return new Response('ok')
  })
  try {
    const result = await new Promise<{
      status: number | undefined
      connection: string | undefined
    }>((resolve, reject) => {
      const client = request(
        server.url,
        {
          method: 'POST',
          headers: { 'content-length': String(32 * 1024 * 1024 + 1) },
        },
        (response) => {
          response.resume()
          response.once('end', () =>
            resolve({
              status: response.statusCode,
              connection: response.headers.connection,
            }),
          )
        },
      )
      client.once('error', reject)
      client.end()
    })
    expect(result).toEqual({ status: 413, connection: 'close' })
    expect(dispatched).toBe(0)
  } finally {
    await server.stop(true)
  }
})

test('IPv6 loopback URLs retain their brackets and transport failures omit private error detail', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {})
  const server = await listenHttp({ hostname: '::1', port: 0 }, (request) => {
    if (new URL(request.url).pathname === '/untyped')
      throw 'private test detail'
    throw new TypeError('private test detail')
  })
  try {
    expect(server.url.hostname).toBe('[::1]')
    for (const path of ['typed', 'untyped']) {
      const response = await fetch(new URL(path, server.url), {
        signal: AbortSignal.timeout(2500),
      })
      expect(response.status).toBe(500)
      expect(await response.text()).not.toContain('private test detail')
    }
    expect(log.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([
      { event: 'transport.error', kind: 'TypeError' },
      { event: 'transport.error', kind: 'Unknown' },
    ])
    const stopping = server.stop()
    expect(server.stop(true)).toBe(stopping)
    await stopping
  } finally {
    log.mockRestore()
    await server.stop(true)
  }
})
