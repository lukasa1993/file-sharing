import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../app/config.ts'
import { createApp } from '../app/application.ts'
import { physicalLocation } from '../app/filesystem/resolver.ts'
import { initialize } from '../scripts/ops.ts'

let temp: string
let state: string
let volume: string
let env: {
  CONFIG_FILE: string
  DATA_DIR: string
  SESSION_SECRET_FILE: string
  BOOTSTRAP_FILE: string
  PUBLIC_ORIGIN: string
}
let mount: {
  id: string
  label: string
  path: string
  sentinel: string
  readOnly?: boolean
}
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'fileserver-config-'))
  state = join(temp, 'instance')
  await initialize(state, 'local-admin')
  volume = join(state, 'storage')
  env = {
    CONFIG_FILE: join(state, 'config/mounts.json'),
    BOOTSTRAP_FILE: join(state, 'config/bootstrap.json'),
    SESSION_SECRET_FILE: join(state, 'config/session.key'),
    DATA_DIR: join(state, 'data'),
    PUBLIC_ORIGIN: 'https://files.example.test',
  }
  mount = {
    id: 'files',
    label: 'Files',
    path: volume,
    sentinel: (await readFile(join(volume, '.fileserver-root'), 'utf8')).trim(),
  }
})
afterEach(async () => {
  await rm(temp, { recursive: true, force: true })
})
async function mounts(...items: unknown[]) {
  await writeFile(env.CONFIG_FILE, JSON.stringify({ mounts: items }))
}

describe('configuration and storage boundaries', () => {
  test('normalizes origins, default settings, private paths and optional bootstrap', async () => {
    await mounts(mount)
    const c = loadConfig({
      ...env,
      PUBLIC_ORIGIN: 'HTTPS://Files.Example.Test:443/',
      TRUSTED_PROXY_CIDRS: ' 192.0.2.0/24, , ::1/128 ',
      BOOTSTRAP_FILE: undefined,
    })
    expect(c.publicOrigin).toBe('https://files.example.test')
    expect(c.port).toBe(8080)
    expect(c.trustedProxies).toEqual(['192.0.2.0/24', '::1/128'])
    expect(c.mounts).toEqual([{ ...mount, readOnly: false }])
    expect(c.dataDir).toBe(env.DATA_DIR)
    expect(c.bootstrapFile).toBeUndefined()
    expect(c.sessionSecret).toBe(
      (await readFile(env.SESSION_SECRET_FILE, 'utf8')).trim(),
    )
    expect(c.transferLimits).toEqual({
      maxChunkBytes: 16777216,
      maxConcurrent: 32,
      perActorConcurrent: 8,
      bytesPerSecond: 0,
      uploadTtlMs: 86400000,
    })
    for (const uri of [
      'http://localhost:8080',
      'http://127.0.0.1',
      'http://[::1]',
    ])
      expect(loadConfig({ ...env, PUBLIC_ORIGIN: uri }).publicOrigin).toBe(uri)
    for (const key of [
      'PUBLIC_ORIGIN',
      'SESSION_SECRET_FILE',
      'DATA_DIR',
      'CONFIG_FILE',
    ])
      expect(() => loadConfig({ ...env, [key]: undefined })).toThrow(
        'Missing configuration',
      )
  })
  test('requires a secure origin without credentials or navigation components', () => {
    for (const url of [
      'not a url',
      'http://files.example.test',
      'https://user@files.example.test',
      'https://user:pw@files.example.test',
      'https://files.example.test/foo',
      'https://files.example.test/?a=1',
      'https://files.example.test/#frag',
      'ftp://localhost',
    ])
      expect(() => loadConfig({ ...env, PUBLIC_ORIGIN: url })).toThrow()
  })
  test.each([
    ['PORT', 1, 65535],
    ['MAX_CHUNK_BYTES', 1024, 33554432],
    ['MAX_TRANSFERS', 1, 512],
    ['MAX_TRANSFERS_PER_USER', 1, 512],
    ['TRANSFER_BYTES_PER_SECOND', 0, Number.MAX_SAFE_INTEGER],
    ['UPLOAD_TTL_SECONDS', 60, 2592000],
  ] as const)(
    'validates numeric limits including both boundaries for %s',
    (key, min, max) => {
      for (const value of [String(min), String(max)])
        expect(() => loadConfig({ ...env, [key]: value })).not.toThrow()
      for (const value of [
        String(min - 1),
        String(max + 1),
        'Infinity',
        '1.1',
        'not-a-number',
      ])
        expect(() => loadConfig({ ...env, [key]: value })).toThrow()
    },
  )
  test('rejects invalid mount specifications and accepts distinct neighboring paths', async () => {
    for (const override of [
      { id: 'A' },
      { id: 'a'.repeat(65) },
      { label: '' },
      { label: 'x'.repeat(129) },
      { path: 'local' },
      { path: '/' },
      { sentinel: ' ' },
      { sentinel: 'x'.repeat(257) },
      { sentinel: 'a\nb' },
      { readOnly: 'yes' },
    ]) {
      await mounts({ ...mount, ...override })
      expect(() => loadConfig(env)).toThrow()
    }
    for (const items of [
      [],
      Array.from({ length: 65 }, () => mount),
      [mount, { ...mount, path: join(temp, 'adjacent') }],
      [mount, { ...mount, id: 'child', path: join(volume, 'missing') }],
      [{ ...mount, id: 'child', path: join(volume, 'missing') }, mount],
    ]) {
      await mounts(...items)
      expect(() => loadConfig(env)).toThrow()
    }
    await mounts(mount, {
      ...mount,
      id: 'archive',
      path: volume + '-archive',
      readOnly: true,
    })
    expect(loadConfig(env).mounts).toHaveLength(2)
  })
  test('rejects oversize or malformed configuration and nonregular config files', async () => {
    for (const contents of ['x'.repeat(65537), '{broken', '{"mounts":null}']) {
      await writeFile(env.CONFIG_FILE, contents)
      expect(() => loadConfig(env)).toThrow()
    }
    expect(() => loadConfig({ ...env, CONFIG_FILE: volume })).toThrow()
  })
  test('validates secret owner permissions, size, link identity and type before startup', async () => {
    await chmod(env.SESSION_SECRET_FILE, 0o640)
    expect(() => loadConfig(env)).toThrow('private')
    await chmod(env.SESSION_SECRET_FILE, 0o600)
    const alias = join(temp, 'alias-key')
    await link(env.SESSION_SECRET_FILE, alias)
    expect(() => loadConfig(env)).toThrow('private')
    await rm(alias)
    await symlink(env.SESSION_SECRET_FILE, alias)
    expect(() => loadConfig({ ...env, SESSION_SECRET_FILE: alias })).toThrow()
    expect(() => loadConfig({ ...env, SESSION_SECRET_FILE: volume })).toThrow()
    for (const secret of ['a'.repeat(31), 'a'.repeat(4097)]) {
      await writeFile(env.SESSION_SECRET_FILE, secret)
      expect(() => loadConfig(env)).toThrow()
    }
    await writeFile(env.SESSION_SECRET_FILE, 'x'.repeat(32))
    expect(loadConfig(env).sessionSecret.length).toBe(32)
  })
  test('resolves escaped Linux bind mount records to their shared backing paths', () => {
    const topology = [
      String.raw`5 1 8:1 /team /srv/served rw - ext4 /dev/x rw`,
      String.raw`7 1 8:1 /team/private\040state /app/data rw - ext4 /dev/x rw`,
    ].join('\n')
    expect(
      physicalLocation(
        '5',
        '/srv/served/private state/fileserver.sqlite',
        topology,
      ),
    ).toEqual(physicalLocation('7', '/app/data/fileserver.sqlite', topology))
    expect(() => physicalLocation('9', '/app/data', topology)).toThrow()
    expect(() => physicalLocation('5', '/app/data', topology)).toThrow()
  })
  test('detects private state aliases even if the data directory does not exist yet', async () => {
    const alias = join(temp, 'alias')
    await symlink(volume, alias)
    for (const path of [volume, alias, join(alias, 'not-created', 'private')])
      expect(() => loadConfig({ ...env, DATA_DIR: path })).toThrow('separate')
    await expect(lstat(join(volume, 'not-created'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    for (const key of [
      'CONFIG_FILE',
      'SESSION_SECRET_FILE',
      'BOOTSTRAP_FILE',
    ] as const) {
      const path = join(volume, key)
      await writeFile(path, await readFile(env[key]), { mode: 0o600 })
      expect(() => loadConfig({ ...env, [key]: join(alias, key) })).toThrow(
        'separate',
      )
    }
    await mounts({ ...mount, path: join(alias, 'missing') })
    expect(() => loadConfig(env)).toThrow('symbolic link')
    await mounts({ ...mount, path: alias })
    expect(() => loadConfig(env)).toThrow('symbolic link')
  })
  test('revalidates private backing locations on late attach and redacts failed probes', async () => {
    const config = loadConfig(env)
    const deferred = join(env.DATA_DIR, 'late-volume')
    // This direct startup fixture represents a still-detached bind: only the
    // first live descriptor reveals the underlying protected location.
    const app = await createApp({
      ...config,
      mounts: [{ ...mount, readOnly: false, path: deferred }],
    })
    const ready = () => app.fetch(new Request(env.PUBLIC_ORIGIN + '/readyz'))
    try {
      expect((await ready()).status).toBe(503)
      await mkdir(deferred)
      await writeFile(join(deferred, '.fileserver-root'), mount.sentinel)
      await writeFile(join(deferred, 'private.txt'), 'private')
      const response = await ready()
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ status: 'unavailable' })
      await expect(
        app.services.fs.list({ mountId: 'files', segments: [] }, () => {}),
      ).rejects.toMatchObject({
        status: 503,
        message: 'Storage mount unavailable',
      })
    } finally {
      await app.close()
    }
  })
  test('protects the data directory, SQLite database and journal companions before opening them', async () => {
    await mounts({ ...mount, path: join(env.DATA_DIR, 'nested') })
    expect(() => loadConfig(env)).toThrow('separate')
    await mounts(mount)
    const publicFile = join(volume, 'keep.txt')
    await writeFile(publicFile, 'keep')
    expect(() => loadConfig({ ...env, DATA_DIR: publicFile })).toThrow()
    await chmod(env.DATA_DIR, 0o777)
    expect(() => loadConfig(env)).toThrow()
    await chmod(env.DATA_DIR, 0o700)
    for (const name of [
      'fileserver.sqlite',
      'fileserver.sqlite-wal',
      'fileserver.sqlite-shm',
      'fileserver.sqlite-journal',
    ]) {
      const path = join(env.DATA_DIR, name)
      await symlink(publicFile, path)
      expect(() => loadConfig(env)).toThrow('private')
      await rm(path)
    }
    const database = join(env.DATA_DIR, 'fileserver.sqlite')
    await writeFile(database, 'ordinary local database fixture')
    expect(() => loadConfig(env)).not.toThrow()
    await rm(database)
    await link(publicFile, database)
    expect(() => loadConfig(env)).toThrow('private')
    expect(await readFile(publicFile, 'utf8')).toBe('keep')
  })
})

async function launch(
  origin: string,
  port: number,
  afterSpawn?: (pid: number) => Promise<void>,
) {
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, '../server.ts')],
    {
      env: {
        ...env,
        PUBLIC_ORIGIN: origin,
        PORT: String(port),
        HOST: '127.0.0.1',
      },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    },
  )
  const request = (path: string, init?: RequestInit) =>
    fetch(origin + path, {
      ...init,
      redirect: 'manual',
      signal: init?.signal ?? AbortSignal.timeout(8000),
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        connection: 'close',
      },
    })
  try {
    await afterSpawn?.(proc.pid)
    const expires = Date.now() + 15000
    while (Date.now() < expires) {
      if (proc.exitCode !== null)
        throw new Error(
          'Server failed to start: ' + (await new Response(proc.stderr).text()),
        )
      const response = await request('/healthz', {
        signal: AbortSignal.timeout(500),
      }).catch(() => null)
      if (response && (await response.json()).status === 'ok')
        return {
          request,
          async stop(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
            proc.kill(signal)
            const timeout = setTimeout(() => proc.kill('SIGKILL'), 12000)
            try {
              const exit = await proc.exited
              if (signal === 'SIGTERM') expect(exit).toBe(0)
              else expect(proc.signalCode).toBe('SIGKILL')
            } finally {
              clearTimeout(timeout)
            }
          },
        }
      await Bun.sleep(40)
    }
    throw new Error('Server startup did not complete')
  } catch (error) {
    proc.kill('SIGKILL')
    await proc.exited
    throw error
  }
}

async function localEndpoint() {
  const probe = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(),
  })
  const port = probe.port
  if (!port) throw new Error('Expected a TCP listener')
  const origin = probe.url.origin
  await probe.stop(true)
  return { port, origin }
}

type Server = Awaited<ReturnType<typeof launch>>
async function signIn(server: Server, origin: string) {
  const login = JSON.parse(await readFile(env.BOOTSTRAP_FILE, 'utf8')) as {
    username: string
    password: string
  }
  const csrf = (html: string) => {
    const value = /<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/.exec(
      html,
    )?.[1]
    if (!value) throw new Error('Expected session CSRF token')
    return value
  }
  const page = await server.request('/login')
  const prelogin = page.headers.getSetCookie()[0]?.split(';')[0]
  if (!prelogin) throw new Error('Expected login cookie')
  const signed = await server.request('/login', {
    method: 'POST',
    headers: { origin, cookie: prelogin },
    body: new URLSearchParams({ ...login, csrf: csrf(await page.text()) }),
  })
  expect(signed.status).toBe(303)
  const cookie = signed.headers.getSetCookie()[0]?.split(';')[0]
  if (!cookie) throw new Error('Expected signed-in cookie')
  const home = await server.request('/_/files?mount=files', {
    headers: { cookie },
  })
  expect(home.status).toBe(200)
  return { cookie, origin, 'X-CSRF-Token': csrf(await home.text()) }
}

test('real process restarts with existing credentials and exposes availability without recreating a missing mount', async () => {
  const { port, origin } = await localEndpoint()
  const file = join(volume, 'note.txt')
  await writeFile(file, 'original')
  await rm(env.DATA_DIR, { recursive: true })
  const first = await launch(origin, port)
  let session = ''
  try {
    expect((await lstat(env.DATA_DIR)).mode & 0o777).toBe(0o700)
    const ready = await first.request('/readyz')
    expect(ready.status).toBe(200)
    expect(await ready.json()).toEqual({ status: 'ready' })
    session = (await signIn(first, origin)).cookie
  } finally {
    await first.stop()
  }
  await rm(env.BOOTSTRAP_FILE)
  const offline = join(temp, 'detached')
  await rename(volume, offline)
  const restarted = await launch(origin, port)
  try {
    const unavailable = await restarted.request('/readyz')
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({ status: 'unavailable' })
    expect((await restarted.request('/healthz')).status).toBe(200)
    await expect(
      readFile(join(volume, '.fileserver-root')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await mkdir(volume)
    await writeFile(join(volume, '.fileserver-root'), 'wrong')
    expect((await restarted.request('/readyz')).status).toBe(503)
    await rm(volume, { recursive: true })
    await rename(offline, volume)
    expect((await restarted.request('/readyz')).status).toBe(200)
    const listing = await restarted.request('/_/api/v1/entries?mount=files', {
      headers: { cookie: session },
    })
    expect(listing.status).toBe(200)
    expect(await listing.text()).toContain('note.txt')
    expect(await readFile(file, 'utf8')).toBe('original')
  } finally {
    await restarted.stop()
  }
}, 40000)

test('SIGKILL after an acknowledged upload chunk resumes the original bytes and session on restart', async () => {
  const { origin, port } = await localEndpoint()
  const original = Uint8Array.from(
    { length: 16387 },
    (_, index) => (index * 17) % 256,
  )
  const split = 7129
  const name = 'résumé.bin'
  const checksum = new Bun.CryptoHasher('sha256').update(original).digest('hex')
  const metadata = Object.entries({
    mount: 'files',
    filename: name,
    sha256: checksum,
  })
    .map(([k, v]) => k + ' ' + Buffer.from(v).toString('base64'))
    .join(',')
  let protocol: Record<string, string> = {}
  let resource = ''
  const patch = (
    server: Server,
    offset: number,
    body: Uint8Array<ArrayBuffer>,
  ) =>
    server.request(resource, {
      method: 'PATCH',
      headers: {
        ...protocol,
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(offset),
      },
      body,
    })
  const first = await launch(origin, port)
  try {
    protocol = { ...(await signIn(first, origin)), 'Tus-Resumable': '1.0.0' }
    const created = await first.request('/_/uploads', {
      method: 'POST',
      headers: {
        ...protocol,
        'Upload-Length': String(original.length),
        'Upload-Metadata': metadata,
      },
    })
    expect(created.status).toBe(201)
    const location = created.headers.get('location')
    if (!location) throw new Error('Expected upload location')
    const url = new URL(location, origin)
    expect(url.origin).toBe(origin)
    resource = url.pathname
    const ack = await patch(first, 0, original.slice(0, split))
    expect(ack.status).toBe(204)
    expect(ack.headers.get('Upload-Offset')).toBe(String(split))
    await expect(lstat(join(volume, name))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  } finally {
    await first.stop('SIGKILL')
  }
  await rm(env.BOOTSTRAP_FILE)
  const resumed = await launch(origin, port)
  try {
    const head = await resumed.request(resource, {
      method: 'HEAD',
      headers: protocol,
    })
    expect(head.status).toBe(200)
    expect(head.headers.get('Upload-Offset')).toBe(String(split))
    expect((await patch(resumed, 0, original.slice(0, split))).status).toBe(409)
    await expect(lstat(join(volume, name))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    const finalized = await patch(resumed, split, original.slice(split))
    expect(finalized.status).toBe(204)
    expect(finalized.headers.get('Upload-Offset')).toBe(String(original.length))
    const downloaded = await resumed.request(
      '/_/download?' + new URLSearchParams({ mount: 'files', path: name }),
      { headers: protocol },
    )
    expect(downloaded.status).toBe(200)
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(original)
    expect(new Uint8Array(await readFile(join(volume, name)))).toEqual(original)
  } finally {
    await resumed.stop()
  }
}, 45000)

test('startup waits for a separate SQLite writer and commits bootstrap only once', async () => {
  const { origin, port } = await localEndpoint()
  const path = join(env.DATA_DIR, 'fileserver.sqlite')
  const writer = new Database(path, { create: true })
  let server: Server | undefined
  try {
    writer.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE fixture_effects(value INTEGER); BEGIN IMMEDIATE; INSERT INTO fixture_effects VALUES(1)',
    )
    server = await launch(origin, port, async (pid) => {
      // Wait for the new service to open this database while our process
      // holds the write lock. A fixed delay from spawn can miss startup entirely.
      const fds = '/proc/' + pid + '/fd'
      const start = Date.now()
      while (true) {
        const names = await readdir(fds)
        const targets = await Promise.all(
          names.map((name) => readlink(join(fds, name)).catch(() => '')),
        )
        if (targets.includes(path)) break
        if (Date.now() - start > 10000)
          throw new Error('Server did not open the locked database')
        await Bun.sleep(10)
      }
      await Bun.sleep(120)
      expect(
        writer
          .query("SELECT count(*) FROM sqlite_master WHERE name='auth_users'")
          .values(),
      ).toEqual([[0]])
      writer.exec('COMMIT')
    })
    const ready = await server.request('/readyz')
    expect(ready.status).toBe(200)
    expect(await ready.json()).toEqual({ status: 'ready' })
    expect(writer.query('SELECT value FROM fixture_effects').values()).toEqual([
      [1],
    ])
    expect(
      writer.query('SELECT username,admin FROM auth_users').values(),
    ).toEqual([['local-admin', 1]])
    expect(
      writer
        .query("SELECT count(*) FROM auth_audit WHERE event='admin.bootstrap'")
        .values(),
    ).toEqual([[1]])
  } finally {
    writer.close()
    if (server) await server.stop()
  }
}, 40000)
