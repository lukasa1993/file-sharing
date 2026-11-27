import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { DateTime, Effect } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import {
  AppError,
  type Entry,
  type ResourceRef,
  type User,
} from '../app/contracts.ts'
import { Shares } from '../app/shares/index.ts'
import { Identity } from '../app/identity/index.ts'
import { contains } from '../app/shares/store.ts'
import type { Clock } from 'effect'

const owner: User = { id: 'owner', username: 'owner', admin: false }
const other: User = { id: 'other', username: 'other', admin: false }
const ref: ResourceRef = { mountId: 'library', segments: ['notes.txt'] }
const folder: ResourceRef = { mountId: 'library', segments: ['photos'] }
const selection: ResourceRef = { mountId: 'library', segments: ['plans.txt'] }
const recipient = {
  sessionId: 'disposable-session',
  user: null,
  csrf: 'fixture',
}
const entry = (
  resource: ResourceRef,
  name: string,
  kind: Entry['kind'],
  version: string,
): Entry => ({
  ref: resource,
  name,
  kind,
  version,
  size: kind === 'file' ? 4 : 0,
  modifiedAt: new Date(0).toISOString(),
})
const reads: Database[] = []
afterEach(() => {
  for (const db of reads.splice(0)) db.close()
})

function fixture(clock?: Clock.Clock) {
  const db = new Database(':memory:')
  reads.push(db)
  db.exec('PRAGMA foreign_keys = ON')
  const users = new Map([
    [owner.id, owner],
    [other.id, other],
  ])
  const entries = [
    entry(ref, 'notes.txt', 'file', '1:2:4:1:1'),
    entry(folder, 'photos', 'directory', '1:3:0:1:1:100'),
    entry(selection, 'plans.txt', 'file', '1:4:4:1:1'),
  ]
  const suspended = new Set<string>()
  const sessions = new Set([recipient.sessionId])
  const identity = new Identity(
    db,
    {
      dataDir: ':memory:',
      publicOrigin: 'http://localhost',
      sessionSecret: crypto.randomUUID(),
      port: 0,
      mounts: [],
    },
    clock,
  )
  const service = new Shares(
    db,
    {
      async stat(ref, guard, action = 'list') {
        guard(action, ref)
        const found = entries.find(
          (item) => JSON.stringify(item.ref) === JSON.stringify(ref),
        )
        if (!found) throw new AppError(404, 'File unavailable.')
        return found
      },
      async list(ref, guard) {
        guard('list', ref)
        return entries.filter(
          (item) =>
            contains(ref, item.ref) &&
            item.ref.segments.length === ref.segments.length + 1,
        )
      },
    },
    {
      allowed: (user, _action, ref) =>
        users.has(user.id) && !suspended.has(ref.segments.join('/')),
      getUser: (id) => users.get(id) ?? null,
      bandwidthBudget: (id) => identity.bandwidthBudget(id),
      sessionActive: (id) => sessions.has(id),
      consumePasswordAttempt: (key, peer) =>
        identity.consumePasswordAttempt(key, peer),
    },
    {
      async download(request, ref, guard, options = {}) {
        const data = entries.find(
          (i) => JSON.stringify(i.ref) === JSON.stringify(ref),
        )
        if (!data) throw new AppError(404, 'Missing file.')
        guard('read', ref)
        options.validateEntry?.(data)
        if (request.method === 'HEAD') return new Response(null)
        options.onStart?.(data.version)
        options.onBytes?.(4)
        return new Response('note')
      },
      async preview(request, ref, guard, options) {
        const response = await this.download(request, ref, guard, options)
        response.headers.set('Content-Disposition', 'inline')
        return response
      },
      async archive(_request, refs, guard, options = {}) {
        for (const ref of refs) guard('read', ref)
        options.onStart?.('archive-v1')
        return new Response('fixture archive')
      },
    },
    clock,
  )
  return { service, db, users, entries, suspended, sessions, identity }
}
const link = (path: string, method = 'GET') =>
  new Request('http://localhost/' + path, { method })
const createInput = {
  access: 'public',
  alias: 'notes',
  confirmPublic: true,
  targets: [ref],
}

describe('share management', () => {
  test('creates a revocable direct alias with scoped listing and audit history', async () => {
    const { service, db } = fixture()
    const share = await service.save(owner, createInput)
    expect(service.list(owner).map((item) => item.alias)).toEqual(['notes'])
    expect(service.list(other)).toEqual([])
    expect(() => service.remove(other, share.id)).toThrow()
    expect(await (await service.public(link('notes'), recipient)).text()).toBe(
      'note',
    )
    expect(service.details(owner, share.id)).toMatchObject({
      bytesServed: 4,
      requests: 1,
    })
    service.remove(owner, share.id)
    await expect(
      service.public(link('notes'), recipient),
    ).rejects.toMatchObject({ status: 404 })
    expect(
      db.query('SELECT event FROM share_history ORDER BY sequence').all(),
    ).toEqual([{ event: 'create' }, { event: 'revoke' }])
  })

  test('requires explicit public confirmation and rejects unavailable aliases and ambiguous selections', async () => {
    const { service } = fixture()
    await expect(
      service.save(owner, { ...createInput, confirmPublic: false }),
    ).rejects.toMatchObject({ status: 400 })
    for (const alias of ['admin', 'readyz', '_', 'UPPER'])
      await expect(
        service.save(owner, { ...createInput, alias }),
      ).rejects.toMatchObject({ status: 400 })
    await expect(
      service.save(owner, { ...createInput, targets: [ref, ref] }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      service.save(owner, { ...createInput, maxBytes: 100 }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      service.save(owner, { ...createInput, unexpected: 'oops' }),
    ).rejects.toMatchObject({ status: 400 })
    const results = await Promise.allSettled([
      service.save(owner, createInput),
      service.save(other, createInput),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
  })

  test('creates a random alias and invalidates a changed representation until reconfirmed', async () => {
    const { service, entries } = fixture()
    const share = await service.save(owner, { ...createInput, alias: '' })
    expect(share.alias).toMatch(/^[a-f0-9]{32}$/)
    const original = entries.find((e) => e.name === 'notes.txt')
    if (!original) throw new Error('Missing fixture.')
    original.version = '1:22:4:2:2'
    await expect(
      service.public(link(share.alias), recipient),
    ).rejects.toMatchObject({ status: 404 })
    expect(service.details(owner, share.id).broken).toBe(true)
    await service.save(owner, { enabled: true }, share.id)
    expect((await service.public(link(share.alias), recipient)).status).toBe(
      200,
    )
  })

  test('editing an alias drops the old URL; disabling and lost owner permissions take effect on the next request', async () => {
    const { service, suspended, users } = fixture()
    const s = await service.save(owner, createInput)
    await service.save(owner, { alias: 'handout', confirmPublic: true }, s.id)
    await expect(
      service.public(link('notes'), recipient),
    ).rejects.toMatchObject({ status: 404 })
    suspended.add('notes.txt')
    await expect(
      service.public(link('handout'), recipient),
    ).rejects.toMatchObject({ status: 404 })
    suspended.clear()
    await service.save(owner, { enabled: false }, s.id)
    await expect(
      service.public(link('handout'), recipient),
    ).rejects.toMatchObject({ status: 404 })
    await service.save(owner, { enabled: true }, s.id)
    users.delete(owner.id)
    await expect(
      service.public(link('handout'), recipient),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('share delivery', () => {
  test('selects individual items using share-local indices and confines browsing to that selection', async () => {
    const { service } = fixture()
    await service.save(owner, { ...createInput, targets: [ref, selection] })
    expect((await service.public(link('notes/~1'), recipient)).status).toBe(200)
    await expect(
      service.public(link('notes/~9'), recipient),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      service.public(link('notes/~1/photos'), recipient),
    ).rejects.toMatchObject({ status: 404 })
    expect(
      await (await service.public(link('notes?archive=1'), recipient)).text(),
    ).toBe('fixture archive')
  })

  test('an upload-only capability cannot list its target or write outside it and expires on revocation', async () => {
    const { service } = fixture()
    const share = await service.save(owner, {
      ...createInput,
      kind: 'upload',
      targets: [folder],
      maxBytes: 400,
    })
    const scope = await service.uploadAccess('notes', recipient)
    expect(scope.cap).toBe(400)
    scope.guard('upload', { ...folder, segments: ['photos', 'cat.jpg'] })
    expect(() => scope.guard('list', folder)).toThrow()
    expect(() => scope.guard('upload', ref)).toThrow()
    expect(() => scope.guard('modify', folder)).toThrow()
    service.remove(owner, share.id)
    expect(scope.revalidate).toThrow()
  })

  test('a password grant is tied to session, share revision and session validity', async () => {
    const { service, sessions } = fixture()
    const s = await service.save(owner, {
      ...createInput,
      access: 'password',
      password: 'sample-only',
    })
    const unlock = () =>
      new Request('http://localhost/_/shares/' + s.id + '/unlock', {
        method: 'POST',
        body: new URLSearchParams({ password: 'sample-only' }),
      })
    expect((await service.public(link('notes'), recipient)).status).toBe(401)
    expect((await service.public(unlock(), recipient)).status).toBe(303)
    expect((await service.public(link('notes'), recipient)).status).toBe(200)
    expect(
      (
        await service.public(link('notes'), {
          ...recipient,
          sessionId: 'different',
        })
      ).status,
    ).toBe(401)
    await service.save(owner, { password: 'replacement' }, s.id)
    expect((await service.public(link('notes'), recipient)).status).toBe(401)
    sessions.clear()
    await expect(service.public(unlock(), recipient)).rejects.toMatchObject({
      status: 404,
    })
  })

  test('TestClock advances link expiry and a download budget counts leases rather than HEAD or repeated requests', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make()
          const { service } = fixture(clock)
          const now = yield* clock.currentTimeMillis
          const s = yield* Effect.promise(() =>
            service.save(owner, {
              ...createInput,
              maxDownloads: 1,
              expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 60_000)),
            }),
          )
          const retrieve = (who = recipient, method = 'GET') =>
            service.public(link(s.alias, method), who)
          yield* Effect.promise(() => retrieve(recipient, 'HEAD'))
          expect(service.details(owner, s.id).requests).toBe(0)
          yield* Effect.promise(() => retrieve())
          yield* Effect.promise(() => retrieve())
          expect(service.details(owner, s.id).requests).toBe(2)
          yield* Effect.promise(async () => {
            await expect(
              retrieve({ ...recipient, sessionId: 'second-session' }),
            ).rejects.toMatchObject({ status: 410 })
          })
          yield* clock.adjust(60_001)
          yield* Effect.promise(async () => {
            await expect(retrieve()).rejects.toMatchObject({ status: 404 })
          })
        }),
      ),
    )
  })
})

describe('sharing HTTP contract', () => {
  test('manages targets through typed JSON and keeps password hashes outside all owner responses', async () => {
    const { service } = fixture()
    const request = (
      path: string,
      method: string,
      body?: unknown,
      contentType = 'application/json',
    ) =>
      new Request('http://localhost/_/api/v1/shares' + path, {
        method,
        headers: { 'Content-Type': contentType },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const created = await service.owner(
      request('', 'POST', {
        ...createInput,
        access: 'password',
        password: 'test-only',
      }),
      owner,
    )
    expect(created.status).toBe(201)
    const data = (await created.json()) as { id: string; alias: string }
    expect(data).not.toHaveProperty('passwordHash')
    const detail = await service.owner(request('/' + data.id, 'GET'), owner)
    expect(await detail.json()).toMatchObject({
      alias: 'notes',
      access: 'password',
    })
    const changed = await service.owner(
      request('/' + data.id, 'PATCH', { access: 'authenticated' }),
      owner,
    )
    expect(changed.status).toBe(200)
    expect((await service.public(link('notes'), recipient)).status).toBe(303)
    expect(
      (await service.public(link('notes'), { ...recipient, user: other }))
        .status,
    ).toBe(200)
    await expect(
      service.owner(request('', 'POST', createInput, 'text/plain'), owner),
    ).rejects.toMatchObject({ status: 415 })
    await expect(
      service.owner(
        new Request('http://localhost/_/api/v1/shares', {
          headers: { Authorization: 'Bearer synthetic' },
        }),
        owner,
      ),
    ).rejects.toMatchObject({ status: 403 })
    expect(
      (await service.owner(request('/' + data.id, 'DELETE'), owner)).status,
    ).toBe(204)
    expect(
      await (await service.owner(request('', 'GET'), owner)).json(),
    ).toEqual([])
  })

  test('a landing page displays the file name, retains the original alias, and spends no transfer lease', async () => {
    const { service } = fixture()
    const s = await service.save(owner, {
      ...createInput,
      mode: 'landing',
      maxDownloads: 1,
    })
    const head = await service.public(link('notes', 'HEAD'), recipient)
    expect(await head.text()).toBe('')
    const landing = await service.public(link('notes'), recipient)
    const html = await landing.text()
    expect(landing.status).toBe(200)
    expect(html).toContain('notes.txt')
    expect(html).toContain('/notes?download=1')
    expect(service.details(owner, s.id)).toMatchObject({
      requests: 0,
      bytesServed: 0,
    })
    expect(
      await (await service.public(link('notes?download=1'), recipient)).text(),
    ).toBe('note')
  })

  test('a folder link browses relative authorized files and stays valid as its contents change', async () => {
    const { service, entries } = fixture()
    const nested = {
      mountId: folder.mountId,
      segments: [...folder.segments, 'cat.txt'],
    }
    entries.push(entry(nested, 'cat.txt', 'file', '1:10:4:2:2'))
    const chosen = entries.find((e) => e.kind === 'directory')
    if (!chosen) throw new Error('Missing folder fixture')
    await service.save(owner, { ...createInput, targets: [folder] })
    chosen.version = '1:3:32:3:3:100'
    expect(
      await (await service.public(link('notes'), recipient)).text(),
    ).toContain('/notes/cat.txt')
    expect(
      await (await service.public(link('notes/cat.txt'), recipient)).text(),
    ).toBe('note')
    chosen.version = '1:99:0:3:3:101'
    await expect(
      service.public(link('notes/cat.txt'), recipient),
    ).rejects.toMatchObject({ status: 404 })
  })

  test('explicit latest-at-path file links accept a replacement and require a new lease for its version', async () => {
    const { service, entries } = fixture()
    const file = entries.find((e) => e.name === 'notes.txt')
    if (!file) throw new Error('Missing file fixture')
    await service.save(owner, {
      ...createInput,
      maxDownloads: 1,
      latestAtPath: true,
    })
    expect(await (await service.public(link('notes'), recipient)).text()).toBe(
      'note',
    )
    file.version = '1:7:4:2:2'
    await expect(
      service.public(link('notes'), recipient),
    ).rejects.toMatchObject({ status: 410 })
  })
})

test('batch revocation is atomic and share owners can see alias history', async () => {
  const { service } = fixture()
  const first = await service.save(owner, createInput)
  const next = await service.save(owner, {
    ...createInput,
    alias: 'other-file',
  })
  const foreign = await service.save(other, {
    ...createInput,
    alias: 'someone-else',
  })
  expect(() =>
    service.batch(owner, { operation: 'revoke', ids: [first.id, foreign.id] }),
  ).toThrow()
  expect(service.list(owner)).toHaveLength(2)
  await service.save(owner, { alias: 'renamed', confirmPublic: true }, first.id)
  expect(service.details(owner, first.id).history.map((h) => h.alias)).toEqual([
    'renamed',
    'notes',
  ])
  service.batch(owner, { operation: 'disable', ids: [first.id, next.id] })
  expect(service.list(owner).every((s) => !s.enabled)).toBe(true)
  service.batch(owner, { operation: 'revoke', ids: [first.id, next.id] })
  expect(service.list(owner)).toHaveLength(0)
  expect(service.list(other)).toHaveLength(1)
})

test('share owners lose target metadata when their folder access changes', async () => {
  const { service, suspended } = fixture()
  const s = await service.save(owner, createInput)
  suspended.add('notes.txt')
  const detail = service.details(owner, s.id)
  expect(detail.status).toBe('Unavailable')
  expect(detail.targets).toEqual([])
  expect(detail.targetNames).toEqual([])
})

test('serves a public selection and routes preview, downloads and archives within its budget', async () => {
  const { service, sessions } = fixture()
  const share = await service.save(owner, {
    ...createInput,
    targets: [ref, folder],
    maxDownloads: 1,
  })
  const page = await service.public(link('notes'), recipient)
  const html = await page.text()
  expect(html).toContain('/notes/~0')
  expect(html).toContain('/notes/~1')
  expect(html).toContain('notes.txt')
  expect(html).toContain('photos')
  expect(
    (await service.public(link('notes/~0?preview=1'), recipient)).headers.get(
      'Content-Disposition',
    ),
  ).toBe('inline')
  expect(await (await service.public(link('notes/~0'), recipient)).text()).toBe(
    'note',
  )
  await expect(
    service.public(link('notes/~1?archive=1'), recipient),
  ).rejects.toMatchObject({ status: 410 })
  await expect(
    service.public(link('notes/~0?archive=1'), recipient),
  ).rejects.toMatchObject({ status: 404 })
  const withoutCookie = { ...recipient, sessionId: null }
  await expect(
    service.public(link('notes/~0'), withoutCookie),
  ).rejects.toMatchObject({ status: 403 })
  expect(service.details(owner, share.id)).toMatchObject({
    requests: 2,
    bytesServed: 8,
  })
  await service.save(owner, {
    ...createInput,
    alias: 'inbox',
    kind: 'upload',
    targets: [folder],
  })
  const upload = await service.public(link('inbox'), recipient)
  expect(await upload.text()).toContain('/_/uploads?share=inbox')
  await expect(
    service.public(link('inbox/photos'), recipient),
  ).rejects.toMatchObject({ status: 404 })
  await expect(service.uploadAccess('notes', recipient)).rejects.toMatchObject({
    status: 404,
  })
  const grant = await service.uploadAccess('inbox', recipient)
  sessions.clear()
  expect(grant.revalidate).toThrow()
  await expect(service.uploadAccess('inbox', recipient)).rejects.toMatchObject({
    status: 404,
  })
})

test('enforces HTTP method, body and batch contracts through the owner endpoint', async () => {
  const { service } = fixture()
  const s = await service.save(owner, createInput)
  const route = 'http://localhost/_/api/v1/shares'
  const post = (body: BodyInit | null, suffix = '') =>
    new Request(route + suffix, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
  for (const [body, status] of [
    [null, 400],
    ['{', 400],
    [' '.repeat(128001), 413],
    [Uint8Array.of(255), 400],
  ] as const)
    await expect(service.owner(post(body), owner)).rejects.toMatchObject({
      status,
    })
  expect(
    (
      await service.owner(new Request(route, { method: 'PUT' }), owner)
    ).headers.get('Allow'),
  ).toBe('GET, POST')
  await expect(
    service.owner(
      post(JSON.stringify({ operation: 'disable', ids: [] }), '/batch'),
      owner,
    ),
  ).rejects.toMatchObject({ status: 400 })
  expect(
    (
      await service.owner(
        post(JSON.stringify({ operation: 'disable', ids: [s.id] }), '/batch'),
        owner,
      )
    ).status,
  ).toBe(204)
  expect(service.details(owner, s.id).enabled).toBe(false)
  expect(
    (await service.public(link('notes', 'POST'), recipient)).headers.get(
      'Allow',
    ),
  ).toBe('GET, HEAD')
})

test('limits password attempts per session and clears the throttle after a minute', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make()
        const { service } = fixture(clock)
        const s = yield* Effect.promise(() =>
          service.save(owner, {
            ...createInput,
            access: 'password',
            password: 'booklet',
          }),
        )
        const uri = 'http://localhost/_/shares/' + s.id + '/unlock'
        const unlock = (password: string) =>
          service.public(
            new Request(uri, {
              method: 'POST',
              body: new URLSearchParams({ password, returnTo: '/login' }),
            }),
            recipient,
          )
        yield* Effect.promise(async () => {
          expect(
            (await service.public(new Request(uri), recipient)).headers.get(
              'Allow',
            ),
          ).toBe('POST')
          await expect(unlock('')).rejects.toMatchObject({ status: 400 })
          for (let i = 0; i < 8; i++)
            expect((await unlock('incorrect')).status).toBe(403)
          await expect(unlock('booklet')).rejects.toMatchObject({ status: 429 })
        })
        yield* clock.adjust(60001)
        yield* Effect.promise(async () => {
          const result = await unlock('booklet')
          expect(result.status).toBe(303)
          expect(result.headers.get('Location')).toBe('/notes')
        })
      }),
    ),
  )
}, 30_000)

test('shares the trusted-client password budget across sign-ins and share unlocks', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make()
        const { service, identity } = fixture(clock)
        const password = 'fixture-booklet'
        const input = { ...createInput, access: 'password', password }
        const first = yield* Effect.promise(() => service.save(owner, input))
        const second = yield* Effect.promise(() =>
          service.save(owner, { ...input, alias: 'agenda' }),
        )
        const readingRoom = '192.0.2.14'
        const office = '192.0.2.15'
        for (let i = 0; i < 29; i++)
          identity.consumePasswordAttempt('login:reader-' + i, readingRoom)
        const unlock = (id: string, peer: string) =>
          service.public(
            new Request('http://localhost/_/shares/' + id + '/unlock', {
              method: 'POST',
              body: new URLSearchParams({ password }),
            }),
            recipient,
            undefined,
            peer,
          )
        yield* Effect.promise(async () => {
          expect((await unlock(first.id, readingRoom)).status).toBe(303)
          await expect(unlock(second.id, readingRoom)).rejects.toMatchObject({
            status: 429,
          })
          expect((await unlock(second.id, office)).status).toBe(303)
        })
        yield* clock.adjust('1 minute')
        yield* Effect.promise(async () => {
          expect((await unlock(second.id, readingRoom)).status).toBe(303)
        })
      }),
    ),
  )
}, 30_000)

test('uses the current administrator role for ownership changes and the management list', async () => {
  const { service, users } = fixture()
  const admin = { id: 'administrator', username: 'administrator', admin: true }
  users.set(admin.id, admin)
  const share = await service.save(owner, createInput)
  await expect(
    service.save(owner, { ownerId: other.id }, share.id),
  ).rejects.toMatchObject({ status: 403 })
  expect(service.list(admin)).toHaveLength(1)
  const changed = await service.save(admin, { ownerId: other.id }, share.id)
  expect(changed.ownerId).toBe(other.id)
  expect(service.list(other).map((s) => s.id)).toEqual([share.id])
  expect(service.list(owner)).toEqual([])
  users.set(admin.id, { ...admin, admin: false })
  expect(service.list(admin)).toEqual([])
  expect(() => service.details(admin, share.id)).toThrow()
  users.delete(admin.id)
  expect(() => service.list(admin)).toThrow()
})

test('recipient pages use the chosen site name across listings, landing pages and password retries', async () => {
  const { service } = fixture()
  const brand = 'Archive Office'
  const make = (alias: string, fields: Record<string, unknown>) =>
    service.save(owner, { ...createInput, alias, ...fields })
  const protectedFile = await make('protected', {
    access: 'password',
    password: 'sample-only',
  })
  await make('landing', { mode: 'landing' })
  await make('folder', { targets: [folder] })
  await make('collection', { targets: [ref, selection] })
  await make('inbox', { targets: [folder], kind: 'upload' })
  for (const alias of [
    'protected',
    'landing',
    'folder',
    'collection',
    'inbox',
  ]) {
    const page = await service.public(link(alias), recipient, brand)
    expect(await page.text()).toContain(brand)
  }
  const retry = new Request(
    'http://localhost/_/shares/' + protectedFile.id + '/unlock',
    {
      method: 'POST',
      body: new URLSearchParams({
        password: 'incorrect',
        returnTo: '/protected?download=1',
      }),
    },
  )
  const response = await service.public(retry, recipient, brand)
  expect(response.status).toBe(403)
  const text = await response.text()
  expect(text).toContain(brand)
  expect(text).toContain('/protected?download=1')
})
