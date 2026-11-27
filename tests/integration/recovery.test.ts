import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../../', import.meta.url))

function spawnOps(...args: string[]) {
  return Bun.spawn([process.execPath, 'scripts/ops.ts', ...args], {
    cwd: project,
    stdout: 'ignore',
    stderr: 'pipe',
  })
}
async function ops(...args: string[]) {
  const proc = spawnOps(...args)
  const [exit, error] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ])
  if (exit !== 0) throw new Error(error.trim() || 'Operator command failed')
}
type Auth = { cookie: string; origin: string; 'X-CSRF-Token': string }
function cookie(r: Response) {
  const value = r.headers.getSetCookie()[0]?.split(';')[0]
  if (!value) throw new Error('Missing session cookie')
  return value
}
function csrf(html: string) {
  const token = /<meta[^>]*name="csrf-token"[^>]*content="([^"]+)"/.exec(
    html,
  )?.[1]
  if (!token) throw new Error('Missing CSRF token')
  return token
}

test('operator commands restore matched ordinary storage, recipient grants, permissions and a partially uploaded guest file', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'fileserver-operator-recovery-'))
  const state = join(temp, 'source'),
    snapshot = join(temp, 'portable'),
    restored = join(temp, 'restored')
  const storage = join(state, 'storage'),
    offline = join(temp, 'offline-storage'),
    copy = join(temp, 'storage-copy')
  const portFinder = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(),
  })
  const origin = portFinder.url.origin,
    port = portFinder.url.port
  await portFinder.stop(true)
  const readerPassword = randomUUID()
  const sharePassword = randomUUID()
  let server: ReturnType<typeof Bun.spawn> | undefined
  const get = (path: string, init: RequestInit = {}) =>
    fetch(new URL(path, origin), {
      redirect: 'manual',
      ...init,
      headers: { Connection: 'close', ...init.headers },
    })
  function spawnServer(root: string) {
    return Bun.spawn([process.execPath, 'run', 'server.ts'], {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        HOST: '127.0.0.1',
        PORT: port,
        PUBLIC_ORIGIN: origin,
        DATA_DIR: join(root, 'data'),
        CONFIG_FILE: join(root, 'config/mounts.json'),
        SESSION_SECRET_FILE: join(root, 'config/session.key'),
        BOOTSTRAP_FILE: join(root, 'config/bootstrap.json'),
      },
      stdout: 'ignore',
      stderr: 'pipe',
    })
  }
  async function start(root: string) {
    server = spawnServer(root)
    const deadline = Date.now() + 15000
    for (;;) {
      if (server.exitCode !== null)
        throw new Error('Shipped server failed to start')
      try {
        const check = await get('/readyz')
        await check.arrayBuffer()
        if (check.status === 200) return
      } catch {
        /* listener has not opened yet */
      }
      if (Date.now() > deadline)
        throw new Error('Shipped server did not become ready')
      await Bun.sleep(35)
    }
  }
  async function stop() {
    if (!server) return
    const current = server
    current.kill('SIGTERM')
    const timer = setTimeout(() => current.kill('SIGKILL'), 12000)
    try {
      expect(await current.exited).toBe(0)
    } finally {
      clearTimeout(timer)
      server = undefined
    }
  }
  async function auth(username: string, password: string): Promise<Auth> {
    const form = await get('/login')
    const res = await get('/login', {
      method: 'POST',
      headers: { origin, cookie: cookie(form) },
      body: new URLSearchParams({
        username,
        password,
        csrf: csrf(await form.text()),
      }),
    })
    expect(res.status).toBe(303)
    const signed = cookie(res)
    const page = await get('/_/account', { headers: { cookie: signed } })
    return { cookie: signed, origin, 'X-CSRF-Token': csrf(await page.text()) }
  }
  const json = (path: string, actor: Auth, fields: Record<string, unknown>) =>
    get(path, {
      method: 'POST',
      headers: { ...actor, 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    })
  const ref = (...segments: string[]) => ({ mountId: 'files', segments })
  try {
    await ops('init', state, 'recovery-owner')
    const bootstrap: { username: string; password: string } = JSON.parse(
      await readFile(join(state, 'config/bootstrap.json'), 'utf8'),
    )
    await mkdir(join(storage, 'published'))
    await mkdir(join(storage, 'inbox'))
    await writeFile(
      join(storage, 'published', 'notes.txt'),
      'same ordinary bytes\n',
    )
    await writeFile(join(storage, 'private.txt'), 'private')
    await writeFile(join(storage, 'replaced.txt'), 'initial')
    await start(state)
    const owner = await auth(bootstrap.username, bootstrap.password)
    expect(
      (
        await json('/_/api/v1/admin', owner, {
          action: 'createUser',
          username: 'restore-reader',
          password: readerPassword,
        })
      ).status,
    ).toBe(200)
    const admin = await (await get('/_/admin', { headers: owner })).text()
    const readerId =
      /<option value="([0-9a-f-]{36})">restore-reader<\/option>/.exec(
        admin,
      )?.[1]
    if (!readerId) throw new Error('New reader absent from administration')
    expect(
      (
        await json('/_/api/v1/admin', owner, {
          action: 'setGrant',
          subjectType: 'user',
          subjectId: readerId,
          mountId: 'files',
          path: 'published',
          permission: 'read',
          effect: 'allow',
        })
      ).status,
    ).toBe(200)
    const ownerId =
      /<option value="([0-9a-f-]{36})">recovery-owner<\/option>/.exec(
        admin,
      )?.[1]
    if (!ownerId) throw new Error('Owner absent from administration')
    expect(
      (
        await json('/_/api/v1/admin', owner, {
          action: 'setQuota',
          userId: ownerId,
          bytes: 8,
        })
      ).status,
    ).toBe(200)
    const allocateOwned = () =>
      get('/_/uploads', {
        method: 'POST',
        headers: {
          ...owner,
          'Tus-Resumable': '1.0.0',
          'Upload-Length': '8',
          'Upload-Metadata':
            'mount ' +
            Buffer.from('files').toString('base64') +
            ',filename ' +
            Buffer.from('charged.txt').toString('base64'),
        },
      })
    const charged = await allocateOwned()
    const chargedUrl = charged.headers.get('Location')
    if (!chargedUrl) throw new Error('Missing account upload URL')
    expect(
      (
        await get(chargedUrl, {
          method: 'PATCH',
          headers: {
            ...owner,
            'Tus-Resumable': '1.0.0',
            'Upload-Offset': '0',
            'Content-Type': 'application/offset+octet-stream',
          },
          body: '12345678',
        })
      ).status,
    ).toBe(204)
    const fileOperation = (fields: Record<string, unknown>) =>
      json('/_/api/v1/files/operations', owner, fields)
    expect(
      (await fileOperation({ operation: 'trash', refs: [ref('charged.txt')] }))
        .status,
    ).toBe(200)
    const trashId = /data-trash-id="([^"]+)"/.exec(
      await (await get('/_/trash', { headers: owner })).text(),
    )?.[1]
    if (!trashId) throw new Error('Missing trashed upload')
    const makeShare = async (
      alias: string,
      target: ReturnType<typeof ref>,
      fields: Record<string, unknown>,
    ) => {
      const response = await json('/_/api/v1/shares', owner, {
        alias,
        targets: [target],
        ...fields,
      })
      expect(response.status).toBe(201)
      return ((await response.json()) as { id: string }).id
    }
    const protectedId = await makeShare(
      'brief',
      ref('published', 'notes.txt'),
      { access: 'password', password: sharePassword, maxDownloads: 1 },
    )
    await makeShare('folder', ref('published'), {
      access: 'public',
      confirmPublic: true,
    })
    await makeShare('stale', ref('replaced.txt'), {
      access: 'public',
      confirmPublic: true,
    })
    await makeShare('drop', ref('inbox'), {
      kind: 'upload',
      access: 'public',
      confirmPublic: true,
    })
    const lockPage = await get('/brief'),
      guestCookie = cookie(lockPage)
    expect(
      (
        await get('/_/shares/' + protectedId + '/unlock', {
          method: 'POST',
          headers: { cookie: guestCookie, origin },
          body: new URLSearchParams({
            password: sharePassword,
            csrf: csrf(await lockPage.text()),
          }),
        })
      ).status,
    ).toBe(303)
    const signedRecipient = { cookie: guestCookie }
    const handoff = await get('/brief', { headers: signedRecipient })
    expect(handoff.status).toBe(200)
    const originalETag = handoff.headers.get('etag')
    expect(await handoff.text()).toBe('same ordinary bytes\n')
    const drop = await get('/drop')
    const uploadHeaders = {
      cookie: cookie(drop),
      origin,
      'X-CSRF-Token': csrf(await drop.text()),
      'Tus-Resumable': '1.0.0',
    }
    const allocated = await get('/_/uploads?share=drop', {
      method: 'POST',
      headers: {
        ...uploadHeaders,
        'Upload-Length': '10',
        'Upload-Metadata':
          'filename ' + Buffer.from('submission.txt').toString('base64'),
      },
    })
    expect(allocated.status).toBe(201)
    const upload = allocated.headers.get('location')
    if (!upload) throw new Error('Missing upload URL')
    const patch = (offset: number, body: string) =>
      get(upload, {
        method: 'PATCH',
        headers: {
          ...uploadHeaders,
          'Upload-Offset': String(offset),
          'Content-Type': 'application/offset+octet-stream',
        },
        body,
      })
    expect((await patch(0, 'first')).headers.get('Upload-Offset')).toBe('5')
    const liveSnapshot = join(temp, 'live-metadata')
    await ops('backup', state, liveSnapshot)
    await expect(
      ops('backup', state, join(temp, 'busy'), '--portable'),
    ).rejects.toThrow('is active')
    await stop()
    // Keep the real portable CLI waiting on a separate SQLite writer after it has claimed maintenance.
    const interrupted = join(temp, 'interrupted')
    const writer = new Database(join(state, 'data', 'fileserver.sqlite'))
    writer.exec('BEGIN IMMEDIATE')
    const blocked = spawnOps('backup', state, interrupted, '--portable')
    try {
      const deadline = Date.now() + 10000
      while (!(await Bun.file(join(interrupted, '.gitignore')).exists())) {
        if (blocked.exitCode !== null || Date.now() > deadline)
          throw new Error('Portable backup never entered maintenance.')
        await Bun.sleep(25)
      }
      const refused = spawnServer(state)
      const [code, reason] = await Promise.all([
        refused.exited,
        new Response(refused.stderr).text(),
      ])
      expect(code).toBe(1)
      expect(reason).toContain('is active')
    } finally {
      blocked.kill('SIGKILL')
      await blocked.exited
      writer.close()
    }
    expect(await Bun.file(join(interrupted, 'manifest.json')).exists()).toBe(
      false,
    )
    await writeFile(join(storage, 'replaced.txt'), 'changed after sharing')
    // The host copies storage independently, including all private staging bytes.
    await cp(storage, copy, { recursive: true, preserveTimestamps: true })
    await ops('backup', state, snapshot, '--portable')
    await ops('restore', liveSnapshot, join(temp, 'legacy-restored'))
    await expect(
      ops('restore', liveSnapshot, join(storage, 'exposed-state')),
    ).rejects.toThrow('outside')
    await rename(storage, offline)
    await cp(copy, storage, { recursive: true, preserveTimestamps: true })
    expect((await stat(join(storage, 'published/notes.txt'))).ino).not.toBe(
      (await stat(join(offline, 'published/notes.txt'))).ino,
    )
    // Extra folder members must not become public through an original directory capability.
    await writeFile(
      join(storage, 'published', 'unexpected.txt'),
      'different snapshot',
    )
    const bad = join(temp, 'failed-restore')
    await expect(ops('restore', snapshot, bad)).rejects.toThrow('match')
    expect(await Bun.file(join(bad, 'data/fileserver.sqlite')).exists()).toBe(
      false,
    )
    await rm(join(storage, 'published', 'unexpected.txt'))
    // An ordinary copy with substituted data at a matching name and length is also rejected.
    await writeFile(
      join(storage, 'published', 'notes.txt'),
      'SAME ORDINARY BYTES\n',
    )
    await expect(ops('restore', snapshot, bad)).rejects.toThrow('match')
    await writeFile(
      join(storage, 'published', 'notes.txt'),
      'same ordinary bytes\n',
    )
    await ops('restore', snapshot, restored)
    await start(restored)
    const resumed = await get('/brief', {
      headers: {
        ...signedRecipient,
        Range: 'bytes=5-12',
        'If-Range': originalETag ?? '',
      },
    })
    expect(resumed.status).toBe(206)
    expect(resumed.headers.get('etag')).toBe(originalETag)
    expect(await resumed.text()).toBe('ordinary')
    expect((await get('/brief')).status).toBe(401)
    expect((await get('/stale')).status).toBe(404)
    expect(await (await get('/folder')).text()).toContain('/folder/notes.txt')
    const reader = await auth('restore-reader', readerPassword)
    expect(
      await (
        await get('/_/download?mount=files&path=published%2Fnotes.txt', {
          headers: reader,
        })
      ).text(),
    ).toBe('same ordinary bytes\n')
    expect(
      (
        await get('/_/download?mount=files&path=private.txt', {
          headers: reader,
        })
      ).status,
    ).toBe(403)
    expect((await get('/_/admin', { headers: reader })).status).toBe(403)
    expect((await get('/_/admin', { headers: owner })).status).toBe(200)
    expect((await allocateOwned()).status).toBe(413)
    expect(
      (await fileOperation({ operation: 'restore', ids: [trashId] })).status,
    ).toBe(200)
    expect(await readFile(join(storage, 'charged.txt'), 'utf8')).toBe(
      '12345678',
    )
    expect(
      (await fileOperation({ operation: 'delete', refs: [ref('charged.txt')] }))
        .status,
    ).toBe(200)
    const newUpload = await allocateOwned()
    expect(newUpload.status).toBe(201)
    const spare = newUpload.headers.get('Location')
    if (!spare)
      throw new Error('Missing account upload URL after restoring quota')
    expect(
      (
        await get(spare, {
          method: 'DELETE',
          headers: { ...owner, 'Tus-Resumable': '1.0.0' },
        })
      ).status,
    ).toBe(204)
    const offset = await get(upload, { method: 'HEAD', headers: uploadHeaders })
    expect(offset.status).toBe(200)
    expect(offset.headers.get('Upload-Offset')).toBe('5')
    expect((await patch(5, '-last')).status).toBe(204)
    expect(
      await readFile(join(storage, 'inbox', 'submission.txt'), 'utf8'),
    ).toBe('first-last')
  } finally {
    try {
      await stop()
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }
}, 120_000)
