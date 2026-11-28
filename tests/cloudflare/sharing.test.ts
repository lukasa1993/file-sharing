import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import {
  CloudSharing,
  type CloudShareFile,
  type SharingSql,
} from '../../cloudflare/sharing.ts'

const owner = { id: 'owner' },
  guest = { id: 'guest' }
const fixtures: Database[] = []
afterEach(() => {
  for (const db of fixtures.splice(0)) db.close()
})
function fixture() {
  const db = new Database(':memory:')
  fixtures.push(db)
  const sql: SharingSql = {
    exec<T extends Record<string, string | number | null>>(
      query: string,
      ...args: (string | number | null)[]
    ) {
      return db.query<T, (string | number | null)[]>(query).all(...args)
    },
  }
  let now = 1_800_000_000_000
  const file: CloudShareFile = {
    id: 'file',
    name: 'Quarterly report.pdf',
    size: 1200,
    expiresAt: now + 100_000,
  }
  const files = new Map([[file.id, file]])
  const reopen = () =>
    new CloudSharing(
      sql,
      (id, fileId) => (id === owner.id ? (files.get(fileId) ?? null) : null),
      () => now,
    )
  return {
    db,
    files,
    file,
    shares: reopen(),
    reopen,
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

test('a public link resolves an owned, ready file and caps the signed download at both expiries', async () => {
  const { shares, file, files, now, reopen } = fixture()
  const shared = await shares.create(owner, {
    kind: 'file',
    fileId: file.id,
    expiresAt: now() + 200_000,
  })
  expect(shared.alias).toMatch(/^[a-f0-9]{32}$/)
  expect(shared.expiresAt).toBe(file.expiresAt)
  expect(shares.recipient(shared.alias)).toEqual({
    kind: 'file',
    access: 'public',
    alias: shared.alias,
  })
  expect(await shares.authorizeDownload(shared.alias, null)).toEqual({
    ownerId: owner.id,
    fileId: file.id,
    name: file.name,
    size: file.size,
    expiresAt: file.expiresAt,
  })
  expect(reopen().list(owner)).toEqual([shared])
  expect(shares.list(guest)).toEqual([])
  const short = await shares.create(owner, {
    kind: 'file',
    fileId: file.id,
    alias: 'q4',
    expiresAt: now() + 1000,
  })
  expect((await shares.authorizeDownload(short.alias, null)).expiresAt).toBe(
    now() + 1000,
  )
  files.set(file.id, { ...file, expiresAt: now() + 500 })
  expect((await shares.authorizeDownload(short.alias, null)).expiresAt).toBe(
    now() + 500,
  )
  files.delete(file.id)
  await expect(
    shares.authorizeDownload(shared.alias, null),
  ).rejects.toMatchObject({ status: 404 })
  expect(() => shares.recipient(shared.alias)).toThrow('Link unavailable')
})

test('verified links, durable revocation and alias ownership are separate across accounts', async () => {
  const { shares, file, reopen } = fixture()
  const input = {
    kind: 'file',
    access: 'verified',
    fileId: file.id,
    alias: 'notes',
  } as const
  await expect(shares.create(null, input)).rejects.toMatchObject({
    status: 401,
  })
  await expect(shares.create(guest, input)).rejects.toMatchObject({
    status: 404,
  })
  const shared = await shares.create(owner, input)
  await expect(
    shares.authorizeDownload(shared.alias, null),
  ).rejects.toMatchObject({ status: 401 })
  expect((await shares.authorizeDownload(shared.alias, guest)).fileId).toBe(
    file.id,
  )
  expect(() => shares.revoke(guest, shared.id)).toThrow('Link unavailable')
  shares.revoke(owner, shared.id)
  const after = reopen()
  expect(after.list(owner)[0]?.revoked).toBe(true)
  await expect(
    after.authorizeDownload(shared.alias, guest),
  ).rejects.toMatchObject({ status: 404 })
  await expect(after.create(owner, input)).rejects.toMatchObject({
    status: 409,
  })
})

test('password links verify before releasing metadata and recheck state after hashing', async () => {
  const { shares, file } = fixture()
  const password = 'temporary test passphrase'
  const shared = await shares.create(owner, {
    kind: 'file',
    fileId: file.id,
    access: 'password',
    password,
  })
  expect(Object.keys(shared)).not.toContain('verifier')
  expect(Object.keys(shares.list(owner)[0] ?? {})).not.toContain('salt')
  expect(shares.recipient(shared.alias)).toEqual({
    kind: 'file',
    access: 'password',
    alias: shared.alias,
  })
  await expect(
    shares.authorizeDownload(shared.alias, guest),
  ).rejects.toMatchObject({ status: 401 })
  await expect(
    shares.authorizeDownload(shared.alias, null, 'different'),
  ).rejects.toMatchObject({ status: 403 })
  expect(
    (await shares.authorizeDownload(shared.alias, null, password)).name,
  ).toBe(file.name)
  const inProgress = shares.authorizeDownload(shared.alias, null, password)
  shares.revoke(owner, shared.id)
  await expect(inProgress).rejects.toMatchObject({ status: 404 })
})

test('a verified upload request stays scoped to its owner and must remain active through completion', async () => {
  const { shares, file, advance, now } = fixture()
  await expect(
    shares.create(owner, { kind: 'request', access: 'public' }),
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    shares.create(owner, { kind: 'request', fileId: file.id }),
  ).rejects.toMatchObject({ status: 400 })
  const request = await shares.create(owner, {
    kind: 'request',
    alias: 'inbox',
    expiresAt: now() + 500,
  })
  expect(shares.recipient('inbox')).toEqual({
    kind: 'request',
    access: 'verified',
    alias: 'inbox',
  })
  expect(() => shares.authorizeUpload('inbox', null)).toThrow(
    'Sign in with a verified account',
  )
  expect(() => shares.authorizeUploadId(request.id, null)).toThrow(
    'Sign in with a verified account',
  )
  expect(shares.authorizeUpload('inbox', guest)).toEqual({
    ownerId: owner.id,
    requestId: request.id,
    expiresAt: request.expiresAt,
  })
  expect(shares.authorizeUploadId(request.id, guest)).toEqual({
    ownerId: owner.id,
    requestId: request.id,
    expiresAt: request.expiresAt,
  })
  await expect(shares.authorizeDownload('inbox', guest)).rejects.toMatchObject({
    status: 404,
  })
  const ordinary = await shares.create(owner, { kind: 'file', fileId: file.id })
  expect(() => shares.authorizeUpload(ordinary.alias, guest)).toThrow(
    'Link unavailable',
  )
  advance(500)
  expect(() => shares.authorizeUploadId(request.id, guest)).toThrow(
    'Link unavailable',
  )
  const next = await shares.create(owner, { kind: 'request' })
  shares.revoke(owner, next.id)
  expect(() => shares.authorizeUploadId(next.id, guest)).toThrow(
    'Link unavailable',
  )
})

test('the recipient password budget persists across object instances and reopens in the next minute', async () => {
  const { shares, reopen, file, advance } = fixture()
  const password = 'shared-session'
  const shared = await shares.create(owner, {
    kind: 'file',
    fileId: file.id,
    access: 'password',
    password,
  })
  for (let i = 0; i < 8; i++)
    expect(
      (
        await shares.authorizeDownload(
          shared.alias,
          null,
          password,
          undefined,
          'reading room',
        )
      ).fileId,
    ).toBe(file.id)
  const after = reopen()
  await expect(
    after.authorizeDownload(
      shared.alias,
      null,
      password,
      undefined,
      'reading room',
    ),
  ).rejects.toMatchObject({ status: 429 })
  expect(
    (
      await after.authorizeDownload(
        shared.alias,
        null,
        password,
        undefined,
        'office',
      )
    ).fileId,
  ).toBe(file.id)
  advance(60_000)
  expect(
    (
      await after.authorizeDownload(
        shared.alias,
        null,
        password,
        undefined,
        'reading room',
      )
    ).fileId,
  ).toBe(file.id)
})
