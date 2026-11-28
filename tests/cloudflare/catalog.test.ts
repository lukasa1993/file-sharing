import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { catalogStorage } from './catalog-storage.ts'
import {
  CloudCatalog,
  cloudLimits as limits,
  type CatalogStorage,
} from '../../cloudflare/catalog.ts'

let db: Database, storage: CatalogStorage, catalog: CloudCatalog
const t = 1_800_000_000_000
beforeEach(() => {
  db = new Database(':memory:', { strict: true })
  storage = catalogStorage(db)
  catalog = new CloudCatalog(storage)
})
afterEach(() => db.close())
function token(value: string | null) {
  if (!value) throw new Error('Expected a new claim')
  return value
}
function allocate(name: string, now = t) {
  const row = catalog.reserve('uploader', name, 10, now, {
    ownerId: 'recipient',
    requestId: 'request',
  })
  const create = catalog.claimCreate('uploader', row.id, now)
  catalog.attach(
    row.id,
    'uploader',
    'remote-multipart-' + row.id,
    token(create.token),
    now,
  )
  return row
}
function publish(name: string, now = t) {
  const row = allocate(name, now)
  const completion = catalog.claimComplete('uploader', row.id, now)
  return catalog.publish(row.id, token(completion.token), now)
}

describe('transactional cloud catalog', () => {
  test('a request recipient receives a verified-owner file only after publication', () => {
    const a = allocate('résumé %.pdf')
    expect(a.key).toBe('files/' + a.id)
    expect(a.key).not.toContain(a.name)
    expect(catalog.own('uploader', a.id)).toBeNull()
    expect(catalog.uploadBy('recipient', a.id)).toBeNull()
    expect(catalog.ready(a.id, t)).toBeNull()
    expect(catalog.list('recipient', t)).toEqual([])
    expect(() => catalog.claimComplete('recipient', a.id, t)).toThrow(
      'not found',
    )
    const claim = catalog.claimComplete('uploader', a.id, t)
    const done = catalog.publish(a.id, token(claim.token), t + 4)
    expect(done.ownerId).toBe('recipient')
    expect(done.requestId).toBe('request')
    expect(done.expiresAt).toBe(t + 4 + limits.retentionMs)
    expect(catalog.ready(a.id, t + 5)).toEqual(done)
    expect(catalog.list('recipient', t + 5)).toEqual([done])
    expect(catalog.list('uploader', t + 5)).toEqual([])
    expect(catalog.publish(a.id, token(claim.token), t + 10)).toEqual(done)
    expect(catalog.claimComplete('uploader', a.id, t + 10).token).toBeNull()
    expect(() => catalog.claimDelete('uploader', a.id, t + 10)).toThrow(
      'not found',
    )
    expect(catalog.usage()).toBe(10)
  })
  test('validates bytes and destination ownership and makes matched create retries idempotent', () => {
    for (const size of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER])
      expect(() => catalog.reserve('u', 'a', size, t)).toThrow()
    for (const name of [
      '',
      '.',
      '..',
      'path/file',
      'a\\b',
      'a\nname',
      '🧭'.repeat(65),
    ])
      expect(() => catalog.reserve('u', name, 0, t)).toThrow()
    const a = catalog.reserve(
      'sender',
      'a',
      limits.maxFileBytes,
      t,
      { ownerId: 'target', requestId: 'first' },
      'key',
    )
    expect(
      catalog.reserve(
        'sender',
        'a',
        limits.maxFileBytes,
        t + 2,
        { ownerId: 'target', requestId: 'first' },
        'key',
      ),
    ).toEqual(a)
    expect(() =>
      catalog.reserve(
        'sender',
        'a',
        limits.maxFileBytes,
        t + 2,
        { ownerId: 'target', requestId: 'second' },
        'key',
      ),
    ).toThrow('Idempotency')
    expect(() =>
      catalog.reserve('sender', 'different', 1, t + 2, undefined, 'key'),
    ).toThrow('Idempotency')
    const empty = catalog.reserve('someone', 'zero', 0, t, undefined, 'key')
    expect(empty.id).not.toBe(a.id)
    expect(empty.ownerId).toBe('someone')
    expect(catalog.usage()).toBe(limits.maxFileBytes)
  })
  test('expired creation leases preserve unknown remote MPU discovery and fence stale attachments', () => {
    const a = catalog.reserve('u', 'a', 17, t)
    const first = catalog.claimCreate('u', a.id, t)
    expect(first.reconcileFirst).toBe(false)
    expect(() => catalog.claimCreate('u', a.id, t + 1)).toThrow('progress')
    expect(() => catalog.claimDelete('u', a.id, t + 1)).toThrow('progress')
    const restarted = new CloudCatalog(storage)
    const retry = restarted.claimCreate('u', a.id, t + limits.claimMs)
    expect(retry.reconcileFirst).toBe(true)
    expect(() =>
      catalog.attach(
        a.id,
        'u',
        'mpu-before-restart',
        token(first.token),
        t + limits.claimMs,
      ),
    ).toThrow('stale')
    expect(restarted.releaseClaim(a.id, token(retry.token))).toBe(true)
    const cleanup = catalog.claimDelete('u', a.id, t + limits.claimMs + 1)
    expect(cleanup.cleanup).toBe('discover')
    expect(catalog.usage()).toBe(17)
    expect(
      catalog.releaseClaim(a.id, cleanup.token, t + limits.claimMs + 500),
    ).toBe(true)
    expect(catalog.claimCleanup(t + limits.claimMs + 100)).toEqual([])
    const confirmed = catalog.claimCleanup(t + limits.claimMs + 500)[0]
    if (!confirmed) throw new Error('Expected a retry')
    expect(confirmed.cleanup).toBe('discover')
    expect(() => catalog.removed(a.id, cleanup.token)).toThrow('stale')
    expect(catalog.removed(a.id, confirmed.token)).toBe(true)
    expect(catalog.removed(a.id, confirmed.token)).toBe(false)
    expect(catalog.usage()).toBe(0)
  })
  test('records an R2 create that finished after upload expiry so the sweeper can abort it', () => {
    const row = catalog.reserve('u', 'a', 10, t)
    const claim = catalog.claimCreate('u', row.id, row.expiresAt - 1)
    catalog.attach(
      row.id,
      'u',
      'remote-id',
      token(claim.token),
      row.expiresAt + 2,
    )
    expect(() => catalog.claimComplete('u', row.id, row.expiresAt + 2)).toThrow(
      'expired',
    )
    const pending = catalog.claimCleanup(row.expiresAt + 2)[0]
    expect(pending).toMatchObject({
      cleanup: 'multipart',
      file: { uploadId: 'remote-id' },
    })
    expect(catalog.usage()).toBe(10)
  })
  test('an interrupted completion can reconcile the published R2 object and ignores abandoned callbacks', () => {
    const a = allocate('a')
    const first = catalog.claimComplete('uploader', a.id, t)
    expect(first.reconcileFirst).toBe(false)
    expect(() => catalog.claimComplete('uploader', a.id, t + 1)).toThrow(
      'progress',
    )
    const now = t + limits.claimMs
    const retry = new CloudCatalog(storage).claimComplete('uploader', a.id, now)
    expect(retry.reconcileFirst).toBe(true)
    expect(() => catalog.publish(a.id, token(first.token), now)).toThrow(
      'stale',
    )
    expect(catalog.releaseClaim(a.id, token(first.token))).toBe(false)
    const done = catalog.publish(a.id, token(retry.token), now)
    expect(done.state).toBe('ready')
    expect(catalog.usage()).toBe(10)
    expect(catalog.ready(a.id, done.expiresAt)).toBeNull()
    const cleanup = catalog.claimCleanup(done.expiresAt)[0]
    if (!cleanup) throw new Error('Expected expired file')
    expect(cleanup.cleanup).toBe('object')
    expect(() =>
      catalog.publish(a.id, token(retry.token), done.expiresAt),
    ).toThrow('expired')
    catalog.removed(a.id, cleanup.token)
    expect(() =>
      catalog.publish(a.id, token(retry.token), done.expiresAt + 5),
    ).toThrow('not found')
  })
  test('holds all four billion bytes through pending, expired and deleting states and queues one alert per upward crossing', () => {
    const files = Array.from({ length: 40 }, (_, i) =>
      catalog.reserve('a', 'f' + i, 100_000_000, t),
    )
    expect(catalog.usage()).toBe(4_000_000_000)
    expect(() => catalog.reserve('b', 'extra', 1, t)).toThrow('capacity')
    const first = catalog.claimAlerts(t)[0]
    if (!first) throw new Error('Expected threshold alert')
    expect(first).toMatchObject({ bytes: 3_600_000_000, attempts: 1 })
    expect(catalog.claimAlerts(t + 1)).toEqual([])
    expect(catalog.releaseAlert(first.id, first.token, t + 1000)).toBe(true)
    expect(catalog.claimAlerts(t + 999)).toEqual([])
    const next = new CloudCatalog(storage).claimAlerts(t + 1000)[0]
    if (!next) throw new Error('Expected retry')
    expect(next.id).toBe(first.id)
    expect(next.token).not.toBe(first.token)
    expect(next.attempts).toBe(2)
    expect(catalog.ackAlert(first.id, first.token)).toBe(false)
    expect(catalog.ackAlert(next.id, next.token)).toBe(true)
    expect(catalog.claimAlerts(t + limits.claimMs * 2)).toEqual([])
    const exp = t + limits.pendingMs
    expect(catalog.claimCleanup(exp - 1)).toEqual([])
    const removals = catalog.claimCleanup(exp, 5)
    expect(removals).toHaveLength(5)
    expect(catalog.usage()).toBe(4_000_000_000)
    for (const c of removals) {
      expect(c.cleanup).toBe('none')
      catalog.removed(c.file.id, c.token)
    }
    expect(catalog.usage()).toBe(3_500_000_000)
    catalog.reserve('a', 'one more', 100_000_000, exp)
    expect(catalog.claimAlerts(exp)).toHaveLength(1)
    expect(new Set(files.map((f) => f.id)).size).toBe(40)
  })
  test('capacity, reservation and alert insertion roll back together', () => {
    for (let i = 0; i < 35; i++)
      catalog.reserve('a', 'file', limits.maxFileBytes, t)
    db.exec(
      "CREATE TRIGGER unavailable BEFORE INSERT ON cloud_capacity_alerts BEGIN SELECT RAISE(ABORT,'fixture unavailable'); END;",
    )
    expect(() =>
      catalog.reserve('u', 'final', limits.maxFileBytes, t, undefined, 'retry'),
    ).toThrow('unavailable')
    expect(catalog.usage()).toBe(3_500_000_000)
    expect(db.query('SELECT count(*) AS count FROM cloud_files').get()).toEqual(
      { count: 35 },
    )
    db.exec('DROP TRIGGER unavailable')
    catalog.reserve('u', 'final', limits.maxFileBytes, t, undefined, 'retry')
    expect(catalog.usage()).toBe(3_600_000_000)
    expect(catalog.claimAlerts(t)).toHaveLength(1)
  })
  test('keyset listing is stable when many filenames and timestamps match', () => {
    for (let i = 0; i < 5; i++) publish('duplicate', t)
    const a = catalog.list('recipient', t, 2)
    const last = a.at(-1)
    if (!last) throw new Error('Expected page')
    const b = catalog.list('recipient', t, 3, last)
    expect(b).toHaveLength(3)
    expect(new Set([...a, ...b].map((f) => f.id)).size).toBe(5)
    expect(catalog.list('recipient', t + limits.retentionMs)).toEqual([])
  })
})
