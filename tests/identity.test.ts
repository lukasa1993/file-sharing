import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { AppError, type AppConfig, type User } from '../app/contracts.ts'
import { Identity } from '../app/identity/index.ts'

const publicOrigin = 'http://127.0.0.1:8080'
const bootstrapPassword = 'test-only-local-password'
let dir: string
let db: Database
let config: AppConfig
let identity: Identity
let admin: User

function userNamed(name: string): User {
  const row = db
    .query<{ id: string }, [string]>(
      'SELECT id FROM auth_users WHERE username=?',
    )
    .get(name)
  if (!row) throw new Error('Test account missing')
  const user = identity.getUser(row.id)
  if (!user) throw new Error('Test account disabled')
  return user
}

function signedCookie(header: string | undefined) {
  const value = header?.split(';')[0]
  if (!value) throw new Error('Expected a signed session cookie')
  return value
}

async function signIn(name = 'owner', password = bootstrapPassword) {
  const get = new Request(publicOrigin + '/login')
  const form = await identity.context(get, true)
  const before = signedCookie(form.setCookie)
  const req = new Request(get.url, {
    method: 'POST',
    headers: {
      cookie: before,
      origin: publicOrigin,
      'X-CSRF-Token': form.csrf,
    },
  })
  const access = await identity.context(req)
  await identity.verifyWrite(req, access)
  const after = await identity.login(req, access, name, password)
  return { before, after, access }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'files-identity-'))
  db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const bootstrapFile = join(dir, 'bootstrap')
  await writeFile(
    bootstrapFile,
    JSON.stringify({ username: 'owner', password: bootstrapPassword }),
    {
      mode: 0o600,
    },
  )
  config = {
    dataDir: dir,
    publicOrigin,
    port: 8080,
    sessionSecret: 'unit-test-32-byte-session-signing-secret',
    bootstrapFile,
    mounts: [
      {
        id: 'files',
        label: 'Files',
        path: join(dir, 'files'),
        readOnly: false,
        sentinel: 'files-test',
      },
    ],
  }
  identity = new Identity(db, config)
  await identity.init()
  admin = userNamed('owner')
})
afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('durable account sessions', () => {
  test('rotates the login cookie, keeps the opaque cookie private, revokes its predecessor and accepts only same-origin form writes', async () => {
    const { before, after, access } = await signIn()
    expect(after).toContain('HttpOnly')
    expect(after).toContain('SameSite=Lax')
    expect(after).toContain('Path=/')
    expect(signedCookie(after)).not.toBe(before)
    expect(
      await identity.current(
        new Request(publicOrigin, { headers: { cookie: before } }),
      ),
    ).toBeNull()
    const login = await identity.context(
      new Request(publicOrigin, { headers: { cookie: signedCookie(after) } }),
    )
    expect(login.user).toEqual(admin)
    expect(login.csrf).not.toBe(access.csrf)
    const change = new Request(publicOrigin + '/logout', {
      method: 'POST',
      headers: { cookie: signedCookie(after), origin: publicOrigin },
      body: new URLSearchParams({ csrf: login.csrf }),
    })
    const context = await identity.context(change)
    await identity.verifyWrite(change, context)
    expect((await change.formData()).get('csrf')).toBe(login.csrf)
    const missing = new Request(change.url, {
      method: 'POST',
      headers: { cookie: signedCookie(after), origin: publicOrigin },
    })
    await expect(
      identity.verifyWrite(missing, await identity.context(missing)),
    ).rejects.toBeInstanceOf(AppError)
    const foreign = new Request(change.url, {
      method: 'POST',
      headers: {
        cookie: signedCookie(after),
        origin: 'https://another.example',
        'X-CSRF-Token': login.csrf,
      },
    })
    await expect(
      identity.verifyWrite(foreign, await identity.context(foreign)),
    ).rejects.toBeInstanceOf(AppError)
    await identity.logout(context)
    expect(
      await identity.current(
        new Request(publicOrigin, { headers: { cookie: signedCookie(after) } }),
      ),
    ).toBeNull()
  })

  test('never re-creates a revoked session from an overlapping SQLite save', async () => {
    const a = await identity.storage.read(null)
    a.set('example', 'first')
    const id = await identity.storage.save(a)
    const old = await identity.storage.read(id)
    const logout = await identity.storage.read(id)
    logout.destroy()
    await identity.storage.save(logout)
    old.set('example', 'second')
    await expect(identity.storage.save(old)).rejects.toBeInstanceOf(AppError)
  })

  test('account reset revokes the current session and cannot disable the last administrator', async () => {
    const { after } = await signIn()
    await expect(
      identity.manage(admin, {
        action: 'setEnabled',
        userId: admin.id,
        enabled: false,
      }),
    ).rejects.toBeInstanceOf(AppError)
    await identity.manage(admin, {
      action: 'resetPassword',
      userId: admin.id,
      password: 'another-local-test-password',
    })
    expect(
      await identity.current(
        new Request(publicOrigin, { headers: { cookie: signedCookie(after) } }),
      ),
    ).toBeNull()
  })

  test('rejects expired sessions and reopens the password budget as the injected clock advances', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make()
          identity = new Identity(db, config, clock)
          yield* Effect.promise(() => identity.init())
          const { after } = yield* Effect.promise(() => signIn())
          const cookie = signedCookie(after)
          const access = yield* Effect.promise(() =>
            identity.context(
              new Request(publicOrigin, { headers: { cookie } }),
            ),
          )
          for (let i = 0; i < 12; i++)
            identity.consumePasswordAttempt('budget-test')
          expect(() => identity.consumePasswordAttempt('budget-test')).toThrow(
            AppError,
          )
          yield* clock.adjust('3 hours')
          expect(() =>
            identity.consumePasswordAttempt('budget-test'),
          ).not.toThrow()
          if (!access.sessionId) throw new Error('Expected an active session')
          expect(identity.sessionActive(access.sessionId)).toBe(false)
          expect(
            yield* Effect.promise(() =>
              identity.current(
                new Request(publicOrigin, { headers: { cookie } }),
              ),
            ),
          ).toBeNull()
        }),
      ),
    )
  })
})

describe('directory policy and scoped tokens', () => {
  test('user/group rules apply at segment boundaries, with nearest prefix and deny on ties', async () => {
    await identity.manage(admin, {
      action: 'createUser',
      username: 'reader',
      password: 'reader-unit-test-password',
    })
    await identity.manage(admin, { action: 'createGroup', name: 'Readers' })
    const group = db
      .query<{ id: string }, []>('SELECT id FROM auth_groups')
      .get()
    if (!group) throw new Error('Expected group')
    const reader = userNamed('reader')
    await identity.manage(admin, {
      action: 'setMembership',
      userId: reader.id,
      groupId: group.id,
      member: true,
    })
    const grant = {
      action: 'setGrant',
      subjectType: 'group',
      subjectId: group.id,
      mountId: 'files',
      permission: 'read',
      path: 'inbox',
      effect: 'allow',
    }
    await identity.manage(admin, grant)
    const ref = (path: string) => ({
      mountId: 'files',
      segments: path.split('/').filter(Boolean),
    })
    expect(identity.allowed(reader, 'read', ref('inbox/a'))).toBe(true)
    expect(identity.allowed(reader, 'read', ref('inbox-archive'))).toBe(false)
    expect(identity.allowed(reader, 'list', ref('inbox'))).toBe(false)
    expect(identity.allowed(reader, 'read', ref(''))).toBe(false)
    await identity.manage(admin, {
      ...grant,
      subjectType: 'user',
      subjectId: reader.id,
      path: 'inbox/private',
      effect: 'deny',
    })
    await identity.manage(admin, { ...grant, path: 'inbox/private' })
    expect(identity.allowed(reader, 'read', ref('inbox/private/a'))).toBe(false)
    await identity.manage(admin, { ...grant, path: 'inbox/private/returned' })
    expect(
      identity.allowed(reader, 'read', ref('inbox/private/returned/a')),
    ).toBe(true)
    await identity.manage(admin, {
      action: 'setEnabled',
      userId: reader.id,
      enabled: false,
    })
    expect(identity.allowed(reader, 'read', ref('inbox'))).toBe(false)
  })

  test('read-only token scope and live revocation are enforced independently of the account role', async () => {
    const result = await identity.self(admin, {
      action: 'issueToken',
      label: 'Downloader',
      scope: 'read',
      days: 1,
    })
    if (!result.token) throw new Error('Expected a newly issued token')
    const headers = { Authorization: 'Bearer ' + result.token }
    const { user } = await identity.context(
      new Request(publicOrigin + '/_/download', { headers }),
    )
    if (!user) throw new Error('Expected token principal')
    const root = { mountId: 'files', segments: [] }
    expect(identity.allowed(user, 'read', root)).toBe(true)
    expect(identity.allowed(user, 'list', root)).toBe(false)
    await expect(
      identity.context(new Request(publicOrigin + '/_/admin', { headers })),
    ).rejects.toBeInstanceOf(AppError)
    const token = db
      .query<{ id: string; digest: string }, []>(
        'SELECT id,digest FROM auth_tokens',
      )
      .get()
    if (!token) throw new Error('Expected token record')
    expect(token.digest).not.toBe(result.token)
    await identity.self(admin, { action: 'revokeToken', id: token.id })
    expect(identity.allowed(user, 'read', root)).toBe(false)
    await expect(
      identity.context(new Request(publicOrigin + '/_/download', { headers })),
    ).rejects.toBeInstanceOf(AppError)
  })
})

test('private homes isolate contents from broader grants and require a deliberate external admin share grant', async () => {
  await identity.manage(admin, {
    action: 'createUser',
    username: 'homeowner',
    password: 'home-owner-unit-password',
  })
  await identity.manage(admin, {
    action: 'createUser',
    username: 'neighbor',
    password: 'neighbor-unit-password',
  })
  const owner = userNamed('homeowner')
  const neighbor = userNamed('neighbor')
  const home = { mountId: 'files', segments: ['people', 'owner'] }
  const child = { mountId: 'files', segments: [...home.segments, 'note.txt'] }
  const grant = {
    action: 'setGrant',
    subjectType: 'user',
    mountId: 'files',
    effect: 'allow',
    path: 'people',
  }
  await identity.manage(admin, {
    ...grant,
    subjectId: neighbor.id,
    permission: 'list',
  })
  await identity.manage(admin, {
    ...grant,
    subjectId: neighbor.id,
    permission: 'read',
  })
  await identity.manage(admin, {
    ...grant,
    subjectId: admin.id,
    permission: 'share',
  })
  await identity.manage(admin, {
    action: 'setHome',
    userId: owner.id,
    mountId: 'files',
    path: 'people/owner',
  })
  expect(identity.home(owner)).toEqual(home)
  expect(identity.allowed(owner, 'list', home)).toBe(true)
  expect(identity.allowed(owner, 'share', child)).toBe(true)
  expect(
    identity.allowed(owner, 'list', { mountId: 'files', segments: ['people'] }),
  ).toBe(false)
  expect(identity.allowed(neighbor, 'list', home)).toBe(false)
  expect(identity.allowed(neighbor, 'read', child)).toBe(false)
  expect(identity.allowed(admin, 'share', child)).toBe(false)
  await identity.manage(admin, {
    ...grant,
    path: 'people/owner',
    subjectId: admin.id,
    permission: 'share',
  })
  expect(identity.allowed(admin, 'share', child)).toBe(true)
  await expect(
    identity.manage(admin, {
      action: 'setHome',
      userId: neighbor.id,
      mountId: 'files',
      path: 'people/owner/new',
    }),
  ).rejects.toBeInstanceOf(AppError)
})

test('session verification uses a private bootstrap and never exposes session cookie material in administration', async () => {
  const { after } = await signIn()
  const adminData = identity.adminData(admin)
  const cookie = signedCookie(after)
  expect(JSON.stringify(adminData)).not.toContain(
    cookie.split('=')[1] ?? 'missing cookie',
  )
  const separate = new Database(':memory:')
  try {
    const publicFile = join(dir, 'world-readable')
    await writeFile(
      publicFile,
      JSON.stringify({
        username: 'guest',
        password: 'another-long-test-password',
      }),
      {
        mode: 0o644,
      },
    )
    // The runner's umask can make new files less permissive than the requested mode.
    await chmod(publicFile, 0o644)
    await expect(
      new Identity(separate, { ...config, bootstrapFile: publicFile }).init(),
    ).rejects.toThrow()
    expect(separate.query('SELECT id FROM auth_users').all()).toHaveLength(0)
  } finally {
    separate.close()
  }
})

test('quota settings support zero, bounded byte counts, and clearing an application quota', async () => {
  await identity.manage(admin, {
    action: 'setQuota',
    userId: admin.id,
    bytes: '0',
  })
  expect(identity.quota(admin.id)).toBe(0)
  await identity.manage(admin, {
    action: 'setQuota',
    userId: admin.id,
    bytes: 9876543210,
  })
  expect(identity.quota(admin.id)).toBe(9876543210)
  await expect(
    identity.manage(admin, { action: 'setQuota', userId: admin.id, bytes: -1 }),
  ).rejects.toBeInstanceOf(AppError)
  await identity.manage(admin, {
    action: 'setQuota',
    userId: admin.id,
    bytes: '',
  })
  expect(identity.quota(admin.id)).toBeNull()
})

test('an unknown account and an incorrect password produce the same failure', async () => {
  const failure = async (name: string, password: string) => {
    try {
      await signIn(name, password)
    } catch (cause) {
      if (!(cause instanceof AppError)) throw cause
      return [cause.status, cause.message]
    }
    throw new Error('Sign-in unexpectedly succeeded')
  }
  expect(await failure('unknown', 'not-this-password')).toEqual(
    await failure('owner', 'not-this-password'),
  )
  expect(identity.adminData(admin).audit).toHaveLength(3)
})
