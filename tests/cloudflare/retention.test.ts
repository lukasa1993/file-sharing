import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CloudCatalog, cloudLimits } from '../../cloudflare/catalog.ts'
import type { R2ControlBinding } from '../../cloudflare/r2.ts'
import {
  CloudWorkspace,
  createCloudWorker,
  type CloudEnvironment,
} from '../../cloudflare/worker.ts'
import { catalogStorage } from './catalog-storage.ts'

const epoch = Date.UTC(2026, 10, 27, 9)
const origin = 'https://files.example.test'
const instances: Database[] = []
afterEach(() => {
  setSystemTime()
  for (const db of instances.splice(0)) db.close()
})
type Email = { from: string; to: string; subject: string; text: string }

function fixture() {
  setSystemTime(epoch)
  const db = new Database(':memory:')
  instances.push(db)
  const storage = catalogStorage(db)
  const catalog = new CloudCatalog(storage)
  const messages: Email[] = []
  const remoteFiles = new Map<string, number>()
  const aborts = new Set<string>()
  const operations: string[] = []
  const alarms: number[] = []
  const background: Promise<unknown>[] = []
  let rejectAlert = false,
    rejectRemoval = false
  const bucket: R2ControlBinding = {
    async createMultipartUpload(key) {
      operations.push('create')
      return this.resumeMultipartUpload(key, crypto.randomUUID())
    },
    resumeMultipartUpload(_key, id) {
      return {
        uploadId: id,
        async abort() {
          aborts.add(id)
        },
        async complete() {
          throw new Error('Unneeded completion in alarm fixture')
        },
      }
    },
    async head(key) {
      operations.push('head')
      const size = remoteFiles.get(key)
      return size === undefined ? null : { size }
    },
    async delete(key) {
      operations.push('delete')
      if (rejectRemoval) throw new Error('Storage temporarily unavailable.')
      remoteFiles.delete(key)
    },
  }
  const state = {
    storage: {
      ...storage,
      async setAlarm(time: number) {
        alarms.push(time)
      },
    },
    waitUntil(promise: Promise<unknown>) {
      background.push(promise)
    },
  } as unknown as ConstructorParameters<typeof CloudWorkspace>[0]
  const env = {
    PUBLIC_ORIGIN: origin,
    R2_ACCOUNT_ID: 'a'.repeat(32),
    R2_BUCKET_NAME: 'dedicated-test',
    R2_ACCESS_KEY_ID: 'fixture',
    R2_SECRET_ACCESS_KEY: 'local-only',
    ALERT_EMAIL: 'operator@example.test',
    MAIL_FROM: 'files@example.test',
    EMAIL: {
      async send(message: Email) {
        messages.push(message)
        if (rejectAlert && message.subject === 'lshare capacity alert')
          throw new Error('Temporary mail failure')
        return { messageId: crypto.randomUUID() }
      },
    },
    BUCKET: bucket,
    WORKSPACE: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        if (id !== 'lshare-v1')
          throw new Error('Maintenance addressed a different object')
        return {
          fetch: (url: string, init: RequestInit) =>
            workspace.fetch(new Request(url, init)),
        }
      },
    },
  } as unknown as CloudEnvironment
  let workspace = new CloudWorkspace(state, env)
  const worker = createCloudWorker()
  const cookies = new Map<string, string>()
  async function api(
    path: string,
    method = 'GET',
    body?: Record<string, unknown>,
  ) {
    const response = await workspace.fetch(
      new Request(origin + path, {
        method,
        headers: {
          Origin: origin,
          Cookie: [...cookies]
            .map(([key, value]) => key + '=' + value)
            .join('; '),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    )
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0] ?? ''
      const i = pair.indexOf('=')
      if (i > 0) cookies.set(pair.slice(0, i), pair.slice(i + 1))
    }
    return response
  }
  async function signIn() {
    const email = 'owner@example.test'
    expect((await api('/api/auth/start', 'POST', { email })).status).toBe(202)
    const code = /\b\d{8}\b/.exec(
      messages.find((x) => x.subject === 'Your lshare sign-in code')?.text ??
        '',
    )?.[0]
    if (!code) throw new Error('No verification code delivered')
    const response = await api('/api/auth/verify', 'POST', { email, code })
    expect(response.status).toBe(200)
    return ((await response.json()) as { user: { id: string } }).user.id
  }
  function publish(owner: string, size: number) {
    const row = catalog.reserve(owner, 'export.bin', size, epoch)
    const create = catalog.claimCreate(owner, row.id, epoch)
    if (!create.token) throw new Error('Missing create claim')
    catalog.attach(row.id, owner, 'finished-id', create.token, epoch)
    const complete = catalog.claimComplete(owner, row.id, epoch)
    if (!complete.token) throw new Error('Missing completion claim')
    remoteFiles.set(row.key, size)
    return catalog.publish(row.id, complete.token, epoch)
  }
  return {
    catalog,
    operations,
    messages,
    alarms,
    remoteFiles,
    aborts,
    api,
    signIn,
    publish,
    alerts: () => messages.filter((m) => m.subject === 'lshare capacity alert'),
    failMail: (fail: boolean) => {
      rejectAlert = fail
    },
    failStorage: (fail: boolean) => {
      rejectRemoval = fail
    },
    restart: () => {
      workspace = new CloudWorkspace(state, env)
    },
    flush: async () => {
      await Promise.all(background.splice(0))
    },
    cron: () =>
      worker.scheduled({} as Parameters<typeof worker.scheduled>[0], env),
    alarm: () => workspace.alarm(),
  }
}

test('parallel verified starts share one final byte; mail failure survives restart and alerts the operator once accepted', async () => {
  const f = fixture()
  const owner = await f.signIn()
  // Pre-fill the ledger without allocating gigabytes on the test machine.
  for (let i = 0; i < 35; i++)
    f.catalog.reserve(owner, 'seed', 100_000_000, epoch)
  f.failMail(true)
  const crossing = await f.api('/api/transfers/uploads', 'POST', {
    name: 'threshold.bin',
    size: 100_000_000,
    idempotencyKey: 'crossing',
  })
  expect(crossing.status).toBe(201)
  await f.flush()
  expect(f.alerts()).toHaveLength(1)
  for (let i = 0; i < 3; i++)
    f.catalog.reserve(owner, 'seed', 100_000_000, epoch)
  f.catalog.reserve(owner, 'seed', 99_999_999, epoch)
  const start = (key: string) =>
    f.api('/api/transfers/uploads', 'POST', {
      name: 'last.bin',
      size: 1,
      idempotencyKey: key,
    })
  const keys = ['allocation-one', 'allocation-two']
  const responses = await Promise.all(keys.map(start))
  expect(responses.map((r) => r.status).sort()).toEqual([201, 507])
  const winner = responses.findIndex((r) => r.status === 201)
  const winningKey = keys[winner],
    original = responses[winner]
  if (!original || !winningKey)
    throw new Error('Expected one accepted reservation')
  const { id } = (await original.json()) as { id: string }
  const retry = await start(winningKey)
  expect(retry.status).toBe(201)
  expect(((await retry.json()) as { id: string }).id).toBe(id)
  await f.flush()
  expect(f.operations).toEqual(['create', 'create'])
  expect(f.catalog.usage()).toBe(4_000_000_000)
  expect(f.alerts()).toHaveLength(1)
  expect(f.alerts()[0]?.to).toBe('operator@example.test')
  expect(f.alerts()[0]?.text).toContain('3,600,000,000')
  expect(f.alerts()[0]?.text).toContain('4,000,000,000')
  f.restart()
  f.failMail(false)
  setSystemTime(epoch + 59_999)
  await f.cron()
  expect(f.alerts()).toHaveLength(1)
  setSystemTime(epoch + 60_000)
  await f.cron()
  expect(f.alerts()).toHaveLength(2)
  expect(f.alerts()[1]).toEqual(f.alerts()[0])
  await f.cron()
  expect(f.alerts()).toHaveLength(2)
})

test('the Worker stops issuing public downloads at thirty days and retains the byte charge through failed remote deletion', async () => {
  const f = fixture()
  const owner = await f.signIn()
  const file = f.publish(owner, 12345)
  const link = await f.api('/api/shares', 'POST', {
    kind: 'file',
    access: 'public',
    alias: 'test-expiry',
    fileId: file.id,
  })
  expect(link.status).toBe(201)
  const path = '/api/links/test-expiry/download'
  setSystemTime(file.expiresAt - 2000)
  const linkBefore = await f.api(path)
  expect(linkBefore.status).toBe(303)
  expect(
    new URL(linkBefore.headers.get('Location') ?? '').searchParams.get(
      'X-Amz-Expires',
    ),
  ).toBe('2')
  await f.cron()
  expect(f.operations).toEqual([])
  setSystemTime(file.expiresAt)
  expect((await f.api(path)).status).toBe(404)
  f.failStorage(true)
  await f.cron()
  expect(f.operations).toEqual(['delete'])
  expect(f.catalog.usage()).toBe(12345)
  expect(f.catalog.own(owner, file.id)?.state).toBe('deleting')
  expect(f.remoteFiles.has(file.key)).toBe(true)
  f.restart()
  setSystemTime(file.expiresAt + 60_000)
  f.failStorage(false)
  await f.cron()
  expect(f.operations).toEqual(['delete', 'delete', 'head'])
  expect(f.catalog.own(owner, file.id)).toBeNull()
  expect(f.catalog.usage()).toBe(0)
  expect(f.remoteFiles.has(file.key)).toBe(false)
  expect((await f.api(path)).status).toBe(404)
})

test('a cleanup backlog rearms the Durable Object alarm and clears only expired reservations and open MPUs', async () => {
  const f = fixture()
  f.catalog.reserve('user', 'still-open', 23, epoch + 10_000)
  const staged = f.catalog.reserve('user', 'staged', 100, epoch)
  const claim = f.catalog.claimCreate('user', staged.id, epoch)
  if (!claim.token) throw new Error('Expected create claim')
  f.catalog.attach(staged.id, 'user', 'partial-123', claim.token, epoch)
  for (let i = 0; i < 25; i++) f.catalog.reserve('user', 'pending', 10, epoch)
  const expires = epoch + cloudLimits.pendingMs
  setSystemTime(expires - 1)
  await f.cron()
  expect(f.catalog.usage()).toBe(373)
  setSystemTime(expires)
  await f.cron()
  expect(f.alarms).toEqual([expires + 1000])
  expect(f.catalog.usage()).toBeGreaterThan(23)
  f.restart()
  setSystemTime(expires + 1000)
  await f.alarm()
  expect([...f.aborts]).toEqual(['partial-123'])
  expect(f.operations).toEqual(['delete', 'head'])
  expect(f.catalog.usage()).toBe(23)
})
