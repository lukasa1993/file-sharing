import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CloudCatalog, cloudLimits } from '../../cloudflare/catalog.ts'
import { CloudSharing } from '../../cloudflare/sharing.ts'
import {
  CloudTransferAdapter,
  cleanupFile,
} from '../../cloudflare/transfers.ts'
import { partBytes, transferApi } from '../../shared/transfers.ts'
import { catalogStorage } from './catalog-storage.ts'

type Storage = ConstructorParameters<typeof CloudTransferAdapter>[1]
const owner = { id: 'owner', email: 'owner@example.test' },
  member = { id: 'member', email: 'member@example.test' }
const base = 'https://cloud.example.test/api/transfers/files'
const parts = [{ partNumber: 1, etag: '"part-1"' }]
let db: Database, catalog: CloudCatalog, sharing: CloudSharing, r2: Storage
let uploads: Map<string, string>,
  objects: Map<string, number>,
  operations: string[]
let now: number, publishedSize: number
function adapter(actor = member, c = catalog) {
  return new CloudTransferAdapter(c, r2, sharing, actor, () => now)
}
beforeEach(() => {
  db = new Database(':memory:', { strict: true })
  const storage = catalogStorage(db)
  catalog = new CloudCatalog(storage)
  sharing = new CloudSharing(
    storage.sql,
    (ownerId, id, at) => {
      const f = catalog.ready(id, at)
      return f?.ownerId === ownerId ? f : null
    },
    () => now,
  )
  now = 1_800_000_000_000
  publishedSize = 9
  uploads = new Map()
  objects = new Map()
  operations = []
  r2 = {
    async create(key) {
      const id = crypto.randomUUID()
      uploads.set(id, key)
      operations.push('create')
      return id
    },
    async discover(key) {
      operations.push('discover')
      return [...uploads].filter(([, k]) => k === key).map(([id]) => id)
    },
    async part(key, id, n, bytes, expires) {
      if (uploads.get(id) !== key) throw new Error('unknown upload')
      return (
        'https://bucket.example/part/' +
        n +
        '?size=' +
        bytes +
        '&until=' +
        expires
      )
    },
    async complete(key, id) {
      if (uploads.get(id) !== key) throw new Error('unknown upload')
      uploads.delete(id)
      objects.set(key, publishedSize)
      operations.push('complete')
    },
    async abort(key, id) {
      operations.push('abort')
      if (uploads.get(id) === key) uploads.delete(id)
    },
    async head(key) {
      const size = objects.get(key)
      return size !== undefined ? { size } : null
    },
    async remove(key) {
      operations.push('remove')
      objects.delete(key)
    },
    async download(key, expires) {
      return 'https://bucket.example/' + key + '?until=' + expires
    },
  }
})
afterEach(() => db.close())

test('a verified upload request caps signed URLs and gives the completed file to its recipient', async () => {
  const a = adapter(),
    recipient = adapter(owner)
  const request = await sharing.create(owner, {
    kind: 'request',
    alias: 'inbox',
    expiresAt: now + 9000,
  })
  publishedSize = partBytes + 9
  const session = await a.create({
    name: 'file.bin',
    size: publishedSize,
    requestAlias: request.alias,
  })
  const p = await a.part(session.id, 2)
  expect(p).toContain('size=9&until=' + (now + 9000))
  await expect(a.part(session.id, 3)).rejects.toMatchObject({ status: 400 })
  await expect(recipient.part(session.id, 1)).rejects.toMatchObject({
    status: 404,
  })
  await expect(a.complete(session.id, parts)).rejects.toMatchObject({
    status: 400,
  })
  const file = await a.complete(session.id, [
    ...parts,
    { partNumber: 2, etag: '"part-2"' },
  ])
  expect(file.size).toBe(publishedSize)
  expect(file).not.toHaveProperty('key')
  expect((await recipient.list(new URL(base))).files).toEqual([file])
  expect((await a.list(new URL(base))).files).toEqual([])
  await expect(a.cancel(file.id)).rejects.toMatchObject({ status: 409 })
  await expect(a.remove(file.id)).rejects.toMatchObject({ status: 404 })
  await expect(a.download(file.id)).rejects.toMatchObject({ status: 404 })
  expect(await recipient.download(file.id)).toContain(
    'https://bucket.example/files/' + file.id,
  )
  await recipient.remove(file.id)
  expect(catalog.usage()).toBe(0)
  await expect(
    a.create({
      name: 'f',
      size: 0,
      target: { mountId: 'other', segments: [] },
    }),
  ).rejects.toMatchObject({ status: 400 })
})

test('replayed allocation discovers the response-lost multipart session and aborts only duplicate sessions at the same key', async () => {
  const input = { name: 'unique', size: 9, idempotencyKey: 'one-filing' }
  const create = r2.create
  let lost = true
  r2.create = async (k, n) => {
    const id = await create(k, n)
    if (lost) {
      lost = false
      throw new Error('lost reply')
    }
    return id
  }
  await expect(adapter().create(input)).rejects.toMatchObject({ status: 503 })
  const existing = [...uploads.entries()][0]
  if (!existing) throw new Error('Missing physical upload')
  uploads.set('duplicate', existing[1])
  const recovered = await adapter().create(input)
  expect((await adapter().create(input)).id).toBe(recovered.id)
  expect(operations).toEqual(['create', 'discover', 'abort'])
  expect([...uploads.keys()]).toEqual([existing[0]])
  expect(catalog.uploadBy(member.id, recovered.id)?.uploadId).toBe(existing[0])
  expect(catalog.usage()).toBe(9)
})

test('completion survives a lost R2 acknowledgement and a lost metadata lookup across object restart', async () => {
  const session = await adapter().create({ name: 'invoice', size: 9 })
  const complete = r2.complete,
    head = r2.head
  let lost = true
  r2.complete = async (...args) => {
    await complete(...args)
    throw new Error('lost response')
  }
  r2.head = async (key) => {
    if (lost) {
      lost = false
      throw new Error('lookup failed')
    }
    return head(key)
  }
  await expect(adapter().complete(session.id, parts)).rejects.toMatchObject({
    status: 503,
  })
  expect(catalog.ready(session.id, now)).toBeNull()
  const restart = new CloudCatalog(catalogStorage(db))
  const file = await adapter(member, restart).complete(session.id, parts)
  now += 10
  expect(await adapter(member, restart).complete(session.id, parts)).toEqual(
    file,
  )
  expect(operations.filter((x) => x === 'complete')).toHaveLength(1)
  expect(restart.usage()).toBe(9)
})

test('a request revoked during remote completion never publishes and its completed object is removed', async () => {
  const request = await sharing.create(owner, { kind: 'request' })
  const a = adapter(),
    session = await a.create({
      name: 'drop',
      size: 9,
      requestAlias: request.alias,
    })
  const complete = r2.complete
  r2.complete = async (...args) => {
    await complete(...args)
    sharing.revoke(owner, request.id)
  }
  await expect(a.complete(session.id, parts)).rejects.toMatchObject({
    status: 404,
  })
  expect(objects.size).toBe(0)
  expect(catalog.uploadBy(member.id, session.id)).toBeNull()
  expect(catalog.usage()).toBe(0)
})

test('a mismatched stored byte count retains the charge until the provider confirms cleanup', async () => {
  const a = adapter(),
    session = await a.create({ name: 'report', size: 9 })
  publishedSize = 8
  const remove = r2.remove
  r2.remove = async () => {
    throw new Error('storage offline')
  }
  await expect(a.complete(session.id, parts)).rejects.toMatchObject({
    status: 503,
  })
  expect(catalog.ready(session.id, now)).toBeNull()
  expect(catalog.usage()).toBe(9)
  expect(catalog.claimCleanup(now)).toEqual([])
  now += 60_000
  const claim = catalog.claimCleanup(now)[0]
  if (!claim) throw new Error('Missing retry')
  r2.remove = remove
  await cleanupFile(catalog, r2, claim, () => now)
  await cleanupFile(catalog, r2, claim, () => now)
  expect(catalog.usage()).toBe(0)
  expect(objects.size).toBe(0)
})

test('signed results are discarded if their request or ready file expires during signing', async () => {
  const request = await sharing.create(owner, {
    kind: 'request',
    expiresAt: now + 2000,
  })
  const session = await adapter().create({
    name: 'inbox',
    size: 9,
    requestAlias: request.alias,
  })
  const part = r2.part
  r2.part = async (...args) => {
    const url = await part(...args)
    now += 2500
    return url
  }
  await expect(adapter().part(session.id, 1)).rejects.toMatchObject({
    status: 404,
  })
  await adapter().cancel(session.id)
  const owned = await adapter().create({ name: 'owned', size: 9 })
  await adapter().complete(owned.id, parts)
  r2.download = async () => {
    now += cloudLimits.retentionMs
    return 'https://bucket.example/'
  }
  await expect(adapter().download(owned.id)).rejects.toMatchObject({
    status: 404,
  })
  expect(catalog.usage()).toBe(9)
  const expired = catalog.claimCleanup(now)[0]
  if (!expired) throw new Error('Missing expired file')
  await cleanupFile(catalog, r2, expired, () => now)
  expect(catalog.usage()).toBe(0)
})

test('a queued cancel past the completion lease cannot remove a newly published file', async () => {
  const a = adapter(),
    session = await a.create({ name: 'in-flight', size: 9 })
  const reached = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>()
  const complete = r2.complete
  r2.complete = async (...args) => {
    reached.resolve()
    await resume.promise
    await complete(...args)
  }
  const publishing = a.complete(session.id, parts)
  await reached.promise
  now += cloudLimits.claimMs + 1
  const cancellation = a.cancel(session.id)
  resume.resolve()
  await publishing
  await expect(cancellation).rejects.toMatchObject({ status: 409 })
  expect(catalog.ready(session.id, now)?.size).toBe(9)
  expect(operations).toEqual(['create', 'complete'])
})

test('stable HTTP pagination survives deletion of the previous page boundary', async () => {
  const a = adapter()
  for (let i = 0; i < 5; i++) {
    const session = await a.create({ name: 'same-name', size: 9 })
    await a.complete(session.id, parts)
  }
  const response = await transferApi(new Request(base + '?limit=2'), a)
  const first = (await response.json()) as Awaited<
    ReturnType<CloudTransferAdapter['list']>
  >
  expect(first.files).toHaveLength(2)
  expect(typeof first.nextCursor).toBe('string')
  await a.remove(first.files[1]!.id)
  const page = await a.list(
    new URL(base + '?limit=3&cursor=' + first.nextCursor),
  )
  expect(page.files).toHaveLength(3)
  expect(page.nextCursor).toBeNull()
  expect(new Set([...first.files, ...page.files].map((f) => f.id)).size).toBe(5)
  await expect(a.list(new URL(base + '?limit=101'))).rejects.toMatchObject({
    status: 400,
  })
  await expect(a.list(new URL(base + '?cursor=invalid'))).rejects.toMatchObject(
    { status: 400 },
  )
})

test('a canceled upload cannot be recreated by a delayed replay of the same allocation key', async () => {
  const a = adapter(),
    input = { name: 'scratch', size: 9, idempotencyKey: 'upload-token' }
  const row = await a.create(input)
  await a.cancel(row.id)
  await expect(a.create(input)).rejects.toMatchObject({ status: 410 })
  expect(operations.filter((op) => op === 'create')).toHaveLength(1)
  now += cloudLimits.pendingMs
  catalog.claimCleanup(now)
  expect((await a.create(input)).id).not.toBe(row.id)
})
test('a request revoked while creating its MPU is aborted before returning a session', async () => {
  const request = await sharing.create(owner, { kind: 'request' })
  const create = r2.create
  r2.create = async (...args) => {
    const id = await create(...args)
    sharing.revoke(owner, request.id)
    return id
  }
  await expect(
    adapter().create({
      name: 'no longer accepted',
      size: 9,
      requestAlias: request.alias,
    }),
  ).rejects.toMatchObject({ status: 404 })
  expect(catalog.usage()).toBe(0)
  expect(uploads.size).toBe(0)
})

test('private signing requires at least one representable SigV4 second of authorization', async () => {
  const request = await sharing.create(owner, {
    kind: 'request',
    expiresAt: now + 750,
  })
  const a = adapter()
  const pending = await a.create({
    name: 'pending',
    size: 9,
    requestAlias: request.alias,
  })
  let partCalls = 0
  const part = r2.part
  r2.part = async (...args) => {
    partCalls++
    return part(...args)
  }
  await expect(a.part(pending.id, 1)).rejects.toMatchObject({ status: 410 })
  expect(partCalls).toBe(0)

  now += 550
  const owned = await a.create({ name: 'ready', size: 9 })
  const file = await a.complete(owned.id, parts)
  now += cloudLimits.retentionMs - 1100
  expect(await a.download(file.id)).toContain('https://bucket.example/')
  let downloads = 0
  r2.download = async () => {
    downloads++
    now += 1000
    throw new RangeError('R2 URL authorization has expired.')
  }
  await expect(a.download(file.id)).rejects.toMatchObject({ status: 404 })
  await expect(a.download(file.id)).rejects.toMatchObject({ status: 404 })
  expect(downloads).toBe(1)
  expect(catalog.ready(file.id, now)).not.toBeNull()
})

test('at day thirty the file disappears immediately and a lost physical delete acknowledgement retains the charge until retry', async () => {
  const a = adapter()
  const pending = await a.create({ name: 'expires', size: 9 })
  const file = await a.complete(pending.id, parts)
  now += cloudLimits.retentionMs - 1
  expect((await a.list(new URL(base))).files).toEqual([file])
  expect(catalog.claimCleanup(now)).toEqual([])
  now++
  expect((await a.list(new URL(base))).files).toEqual([])
  await expect(a.download(file.id)).rejects.toMatchObject({ status: 404 })
  expect(objects.size).toBe(1)
  const expired = catalog.claimCleanup(now)[0]
  if (!expired) throw new Error('Missing expiry claim')
  const remove = r2.remove
  r2.remove = async (key) => {
    await remove(key)
    throw new Error('Lost delete response')
  }
  await expect(
    cleanupFile(catalog, r2, expired, () => now),
  ).rejects.toMatchObject({ status: 503 })
  expect(objects.size).toBe(0)
  expect(catalog.usage()).toBe(9)
  expect(catalog.claimCleanup(now)).toEqual([])
  now += 60_000
  const restarted = new CloudCatalog(catalogStorage(db))
  const retry = restarted.claimCleanup(now)[0]
  if (!retry) throw new Error('Missing restarted expiry claim')
  r2.remove = remove
  await cleanupFile(restarted, r2, retry, () => now)
  await cleanupFile(restarted, r2, expired, () => now)
  expect(restarted.usage()).toBe(0)
  expect(operations.filter((op) => op === 'remove')).toHaveLength(2)
})
