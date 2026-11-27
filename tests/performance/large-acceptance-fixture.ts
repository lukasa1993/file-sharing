import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { initialize } from '../../scripts/ops.ts'

async function localOrigin() {
  const probe = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(),
  })
  const origin = probe.url.origin
  await probe.stop(true)
  return origin
}

const csrf = (html: string) => {
  const value = /<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/.exec(
    html,
  )?.[1]
  assert.ok(value, 'Expected CSRF token')
  return value
}

export async function fixture(state: string, signal: AbortSignal) {
  const origin = await localOrigin()
  const password = randomBytes(32).toString('base64url')
  const username = 'acceptance-owner'
  await initialize(state, username, { mountId: 'acceptance', password })
  const bootstrap = join(state, 'config/bootstrap.json')
  let peak = 0
  let baseline = 0
  let proc: ReturnType<typeof spawnServer> | undefined
  function spawnServer() {
    return Bun.spawn(
      [process.execPath, join(import.meta.dir, '../../server.ts')],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOST: '127.0.0.1',
          PORT: new URL(origin).port,
          PUBLIC_ORIGIN: origin,
          DATA_DIR: join(state, 'data'),
          CONFIG_FILE: join(state, 'config/mounts.json'),
          BOOTSTRAP_FILE: bootstrap,
          SESSION_SECRET_FILE: join(state, 'config/session.key'),
        },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'inherit',
      },
    )
  }
  function request(path: string, init: RequestInit = {}) {
    const url = new URL(path, origin)
    assert.equal(url.origin, origin)
    return fetch(url, {
      ...init,
      redirect: 'manual',
      timeout: false,
      signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
    })
  }
  async function sample() {
    assert.ok(proc)
    const data = await readFile('/proc/' + proc.pid + '/status', 'utf8')
    const rss = (field: string) =>
      Number(new RegExp('^' + field + ':\\s*(\\d+)', 'm').exec(data)?.[1]) *
      1024
    peak = Math.max(peak, rss('VmHWM'))
    return rss('VmRSS')
  }
  async function start() {
    proc = spawnServer()
    const limit = Date.now() + 30000
    while (Date.now() < limit) {
      signal.throwIfAborted()
      assert.equal(proc.exitCode, null, 'Server exited during startup')
      const response = await request('/readyz', {
        signal: AbortSignal.timeout(500),
      }).catch(() => undefined)
      if (response && (await response.json()).status === 'ready') {
        const current = await sample()
        if (!baseline) baseline = current
        return
      }
      await Bun.sleep(30)
    }
    throw new Error('Fixture server failed its readiness deadline')
  }
  async function stop(abrupt = false) {
    if (!proc) return
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        await sample()
      } finally {
        proc.kill(abrupt ? 'SIGKILL' : 'SIGTERM')
        const timer = setTimeout(() => proc?.kill('SIGKILL'), 12000)
        try {
          const exit = await proc.exited
          if (abrupt) assert.equal(proc.signalCode, 'SIGKILL')
          else assert.equal(exit, 0, 'Fixture server failed graceful shutdown')
        } finally {
          clearTimeout(timer)
        }
      }
    }
    proc = undefined
  }
  try {
    await start()
    const login = await request('/login')
    const before = login.headers.getSetCookie()[0]?.split(';')[0]
    assert.ok(before)
    const signed = await request('/login', {
      method: 'POST',
      headers: { origin, cookie: before },
      body: new URLSearchParams({
        username,
        password,
        csrf: csrf(await login.text()),
      }),
    })
    assert.equal(signed.status, 303)
    const cookie = signed.headers.getSetCookie()[0]?.split(';')[0]
    assert.ok(cookie)
    const home = await request('/_/files?mount=acceptance', {
      headers: { cookie },
    })
    assert.equal(home.status, 200)
    const headers = { cookie, origin, 'X-CSRF-Token': csrf(await home.text()) }
    return {
      request,
      headers,
      stop,
      async restart() {
        await stop(true)
        await rm(bootstrap)
        await start()
      },
      async memory() {
        await sample()
        return { baselineBytes: baseline, peakBytes: peak }
      },
      async share(name: string) {
        const response = await request('/_/api/v1/shares', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targets: [{ mountId: 'acceptance', segments: [name] }],
            alias: 'acceptance-download',
            access: 'public',
            confirmPublic: true,
            mode: 'direct',
          }),
        })
        assert.equal(
          response.status,
          201,
          'Could not share acceptance fixture: ' + (await response.text()),
        )
        return '/acceptance-download'
      },
    }
  } catch (error) {
    await stop()
    throw error
  }
}
export type Fixture = Awaited<ReturnType<typeof fixture>>
