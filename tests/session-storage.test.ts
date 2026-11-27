import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { initializeIdentitySchema } from '../app/identity/schema.ts'
import { digest, SqliteSessions } from '../app/identity/session.ts'

const minute = 60_000
const hour = 60 * minute
const epoch = 1_000_000

function withStorage(
  run: (
    store: SqliteSessions,
    db: Database,
    setAge: (ms: number) => Promise<void>,
  ) => Promise<void>,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make()
        yield* clock.setTime(epoch)
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(':memory:')),
          (db) => Effect.sync(() => db.close()),
        )
        db.exec('PRAGMA foreign_keys=ON')
        initializeIdentitySchema(db)
        db.query(
          'INSERT INTO auth_users(id,username,passwordHash) VALUES (?,?,?)',
        ).run('user', 'member', 'unused')
        yield* Effect.promise(() =>
          run(new SqliteSessions(db, clock), db, (ms) =>
            Effect.runPromise(clock.setTime(epoch + ms)),
          ),
        )
      }),
    ),
  )
}

async function create(store: SqliteSessions, owner?: string) {
  const session = await store.read(null)
  session.set('cart', 'report')
  if (owner) session.set('userId', owner)
  expect(await store.save(session)).toBe(session.id)
  return session
}

function row(db: Database, id: string) {
  return db
    .query<
      {
        revision: number
        lastSeen: number
        createdAt: number
        userId: string | null
        data: string
        publicId: string
      },
      [string]
    >(
      'SELECT revision,lastSeen,createdAt,userId,data,publicId FROM auth_sessions WHERE id=?',
    )
    .get(digest(id))
}

test('session storage persists opaque IDs, durable fields, one-request flash and clean reads', () =>
  withStorage(async (store, db) => {
    expect(digest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    const unknown = await store.read('obsolete')
    expect(store.key(unknown)).toBeNull()
    expect(unknown.id).not.toBe('obsolete')
    expect(await store.save(unknown)).toBeNull()
    unknown.destroy()
    expect(await store.save(unknown)).toBe('')
    const session = await create(store, 'user')
    expect(store.key(session)).toBe(digest(session.id))
    const first = row(db, session.id)
    expect(first).toMatchObject({
      revision: 0,
      createdAt: epoch,
      lastSeen: epoch,
      userId: 'user',
    })
    expect(first?.publicId).toMatch(/^[0-9a-f-]{36}$/)
    expect(first?.publicId).not.toBe(session.id)
    const loaded = await store.read(session.id)
    expect(loaded.id).toBe(session.id)
    expect(store.key(loaded)).toBe(digest(session.id))
    expect(loaded.get('cart')).toBe('report')
    expect(await store.save(loaded)).toBeNull()
    loaded.flash('notice', 'saved')
    await store.save(loaded)
    const next = await store.read(loaded.id)
    expect(next.get('notice')).toBe('saved')
    await store.save(next)
    expect((await store.read(loaded.id)).get('notice')).toBeUndefined()
    expect(row(db, loaded.id)?.revision).toBe(2)
    expect(store.active(digest(loaded.id))).toBe(true)
    db.query('UPDATE auth_users SET enabled=0 WHERE id=?').run('user')
    expect(store.active(digest(loaded.id))).toBe(false)
    expect(store.active('unknown')).toBe(false)
  }))

test('conflicting saves, rotations and logout retries cannot revive an earlier credential', () =>
  withStorage(async (store, db) => {
    const session = await create(store)
    const oldId = session.id
    const staleWriter = await store.read(oldId)
    const staleRotation = await store.read(oldId)
    session.set('count', 1)
    await store.save(session)
    session.set('count', 2)
    await store.save(session)
    expect(row(db, oldId)?.revision).toBe(2)
    staleWriter.set('cart', 'stale')
    await expect(store.save(staleWriter)).rejects.toMatchObject({
      status: 401,
      message: 'Session expired. Please sign in again.',
    })
    staleRotation.regenerateId(true)
    await expect(store.save(staleRotation)).rejects.toMatchObject({
      status: 401,
      message: 'Session expired. Please sign in again.',
    })
    const beforeLogout = await store.read(oldId)
    const previousPublicId = row(db, oldId)?.publicId
    session.regenerateId(true)
    session.set('userId', 'user')
    const rotated = session.id
    expect(await store.save(session)).toBe(rotated)
    expect(store.key(session)).toBe(digest(rotated))
    expect(row(db, oldId)).toBeNull()
    expect(row(db, rotated)).toMatchObject({ revision: 0, userId: 'user' })
    expect(row(db, rotated)?.publicId).not.toBe(previousPublicId)
    session.set('cart', 'pending')
    await store.save(session)
    expect(row(db, rotated)?.revision).toBe(1)
    beforeLogout.destroy()
    expect(await store.save(beforeLogout)).toBe('')
    expect(store.active(digest(rotated))).toBe(true)
    const held = await store.read(rotated)
    session.destroy()
    expect(await store.save(session)).toBe('')
    held.set('cart', 'retry')
    await expect(store.save(held)).rejects.toMatchObject({ status: 401 })
    held.regenerateId(true)
    await expect(store.save(held)).rejects.toMatchObject({ status: 401 })
    expect(row(db, held.id)).toBeNull()
    expect((await store.read(rotated)).id).not.toBe(rotated)
  }))

test('reading refreshes the idle timestamp at most once per minute', () =>
  withStorage(async (store, db, setAge) => {
    const session = await create(store, 'user')
    await setAge(minute)
    await store.read(session.id)
    expect(row(db, session.id)?.lastSeen).toBe(epoch)
    await setAge(minute + 1)
    await store.read(session.id)
    expect(row(db, session.id)?.lastSeen).toBe(epoch + minute + 1)
    await setAge(2 * hour)
    expect(store.active(digest(session.id))).toBe(true)
    await setAge(2 * hour + minute + 1)
    expect(store.active(digest(session.id))).toBe(false)
  }))

for (const [name, lifetime, owner] of [
  ['anonymous', 20 * minute, null],
  ['idle', 2 * hour, 'user'],
  ['absolute', 24 * hour, 'user'],
] as const) {
  test(
    'reads, writes, rotations and active checks expire at the exact ' +
      name +
      ' boundary',
    () =>
      withStorage(async (store, db, setAge) => {
        const session = await create(store, owner ?? undefined)
        const shadow = await store.read(session.id)
        const oldId = session.id
        if (name === 'absolute') {
          // Simulate regular activity so the absolute and idle expiry paths are independent.
          db.query('UPDATE auth_sessions SET lastSeen=? WHERE id=?').run(
            epoch + lifetime - minute,
            digest(oldId),
          )
        }
        await setAge(lifetime - 1)
        expect(store.active(digest(oldId))).toBe(true)
        store.sweep()
        expect(row(db, oldId)).not.toBeNull()
        await setAge(lifetime)
        expect(store.active(digest(oldId))).toBe(false)
        session.set('cart', 'expired')
        await expect(store.save(session)).rejects.toMatchObject({ status: 401 })
        shadow.regenerateId(true)
        await expect(store.save(shadow)).rejects.toMatchObject({ status: 401 })
        expect(row(db, shadow.id)).toBeNull()
        // Sweeping is throttled. An individual read must still remove the expired row immediately.
        const replacement = await store.read(oldId)
        expect(replacement.id).not.toBe(oldId)
        expect(store.key(replacement)).toBeNull()
        expect(row(db, oldId)).toBeNull()
      }),
  )
}

test('sweeping removes expired session and token rows once per minute', () =>
  withStorage(async (store, db, setAge) => {
    const anon = await create(store)
    const user = await create(store, 'user')
    const expired = 'expired'
    const live = 'live'
    const insert = db.query(
      "INSERT INTO auth_tokens(id,userId,digest,label,scope,expiresAt) VALUES(?,'user',?,'demo','read',?)",
    )
    insert.run(expired, 'a', epoch + minute)
    insert.run(live, 'b', epoch + minute + 1)
    const tokenIds = () =>
      db
        .query<{ id: string }, []>('SELECT id FROM auth_tokens ORDER BY id')
        .all()
        .map((t) => t.id)
    db.query('UPDATE auth_sessions SET createdAt=? WHERE id=?').run(
      epoch - 20 * minute,
      digest(anon.id),
    )
    await setAge(minute - 1)
    store.sweep()
    expect(row(db, anon.id)).not.toBeNull()
    expect(tokenIds()).toEqual([expired, live])
    await setAge(minute)
    store.sweep()
    expect(row(db, anon.id)).toBeNull()
    expect(tokenIds()).toEqual([live])
    expect(row(db, user.id)).not.toBeNull()
  }))

test('persisted session data must contain exactly two maps and agree with the stored owner', () =>
  withStorage(async (store, db) => {
    const anon = await create(store)
    const key = digest(anon.id)
    const replace = db.query('UPDATE auth_sessions SET data=? WHERE id=?')
    replace.run('broken', key)
    await expect(store.read(anon.id)).rejects.toMatchObject({
      status: 503,
      message: 'Session storage is unavailable.',
      cause: expect.any(SyntaxError),
    })
    for (const encoded of [
      'null',
      '{}',
      '[]',
      '[{}]',
      '[{},{},{}]',
      '[null,{}]',
      '[[],{}]',
      '[1,{}]',
      '[{},null]',
      '[{},[]]',
      '[{},1]',
      '[{"userId":"member"},{}]',
    ]) {
      replace.run(encoded, key)
      await expect(store.read(anon.id)).rejects.toMatchObject({
        status: 503,
        message: 'Session storage is unavailable.',
      })
    }
    const user = await create(store, 'user')
    replace.run('[{},{}]', digest(user.id))
    await expect(store.read(user.id)).rejects.toMatchObject({ status: 503 })
    const invalidOwner = await store.read(null)
    invalidOwner.set('userId', 7)
    await expect(store.save(invalidOwner)).rejects.toThrow(
      'Invalid session owner',
    )
    expect(row(db, invalidOwner.id)).toBeNull()
  }))

test('a full anonymous pool rejects new guests and still permits a signed-in session', () =>
  withStorage(async (store, db) => {
    db.exec(`WITH RECURSIVE indices(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM indices WHERE n<9999)
      INSERT INTO auth_sessions(id,publicId,data,createdAt,lastSeen) SELECT 'id-'||n,'public-'||n,'[{},{}]',1000000,1000000 FROM indices`)
    const last = await create(store)
    const overflow = await store.read(null)
    overflow.set('cart', 'extra')
    await expect(store.save(overflow)).rejects.toMatchObject({
      status: 429,
      message: 'Too many active anonymous sessions. Try again later.',
    })
    expect(row(db, overflow.id)).toBeNull()
    const user = await create(store, 'user')
    expect(store.active(digest(user.id))).toBe(true)
    last.destroy()
    await store.save(last)
    expect(await store.save(overflow)).toBe(overflow.id)
  }))
