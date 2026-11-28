import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { cloudApi } from '../../cloudflare/api.ts'
import { CloudCatalog, type CatalogStorage } from '../../cloudflare/catalog.ts'
import {
  CloudIdentity,
  type CloudAuthStorage,
} from '../../cloudflare/identity.ts'
import { R2Transfers } from '../../cloudflare/r2.ts'
import { CloudSharing, type SharingSql } from '../../cloudflare/sharing.ts'

const origin = 'https://files.example.test'
const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
function fixture() {
  const db = new Database(':memory:')
  databases.push(db)
  const sql: SharingSql & CloudAuthStorage['sql'] = {
    exec<T extends Record<string, string | number | null>>(
      query: string,
      ...values: (string | number | null)[]
    ) {
      let rows: T[] = []
      if (query.includes('CREATE TABLE')) db.exec(query)
      else rows = db.query<T, (string | number | null)[]>(query).all(...values)
      return Object.assign(rows, {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw Error('Expected one SQL row')
          return rows[0]
        },
      })
    },
  }
  const storage = {
    sql,
    transactionSync: <T>(work: () => T) => db.transaction(work)(),
  }
  const identity = new CloudIdentity(storage),
    catalog = new CloudCatalog(storage as unknown as CatalogStorage)
  const sharing = new CloudSharing(sql, (owner, id, now) => {
    const file = catalog.ready(id, now)
    return file?.ownerId === owner ? file : null
  })
  const unused = (): never => {
    throw Error('The download control route must only sign a URL.')
  }
  const r2 = new R2Transfers({
    BUCKET: {
      head: unused,
      delete: unused,
      createMultipartUpload: unused,
      resumeMultipartUpload: unused,
    },
    R2_ACCOUNT_ID: '0'.repeat(32),
    R2_BUCKET_NAME: 'test-downloads',
    R2_ACCESS_KEY_ID: 'local-fixture-key',
    R2_SECRET_ACCESS_KEY: crypto.randomUUID(),
  })
  const messages: string[] = []
  const env = {
    MAIL_FROM: 'workspace@example.test',
    EMAIL: {
      send: async (message: { text: string }) => {
        messages.push(message.text)
      },
    },
  }
  const send = (
    path: string,
    method = 'GET',
    cookie = '',
    body?: Record<string, unknown> | URLSearchParams,
  ) => {
    const headers = new Headers({ origin, ...(cookie ? { cookie } : {}) })
    if (body && !(body instanceof URLSearchParams))
      headers.set('Content-Type', 'application/json')
    const request = new Request(origin + path, {
      method,
      headers,
      ...(body === undefined
        ? {}
        : {
            body: body instanceof URLSearchParams ? body : JSON.stringify(body),
          }),
    })
    return cloudApi(request, env, { identity, catalog, r2, sharing })
  }
  async function login(email: string) {
    const challenge = await send('/api/auth/start', 'POST', '', { email })
    const challengeCookie = challenge.headers.getSetCookie()[0]?.split(';')[0]
    const code = messages.at(-1)?.match(/\b\d{8}\b/)?.[0]
    if (!challengeCookie || !code)
      throw Error('Verification email was not delivered.')
    const verified = await send('/api/auth/verify', 'POST', challengeCookie, {
      email,
      code,
    })
    const cookie = verified.headers
      .getSetCookie()
      .find((value) => value.startsWith('__Host-lshare-session='))
      ?.split(';')[0]
    if (!cookie)
      throw Error('Account verification did not establish a session.')
    const me = (await (await send('/api/auth/me', 'GET', cookie)).json()) as {
      user: { id: string }
    }
    return { cookie, id: me.user.id }
  }
  function ready(owner: string) {
    const now = Date.now(),
      row = catalog.reserve(owner, 'notes.txt', 5, now)
    const create = catalog.claimCreate(owner, row.id, now)
    if (!create.token) throw new Error('Missing allocation')
    catalog.attach(row.id, owner, 'multipart-id', create.token, now)
    const complete = catalog.claimComplete(owner, row.id, now)
    if (!complete.token) throw new Error('Missing publication')
    return catalog.publish(row.id, complete.token, now)
  }
  return { send, login, ready, r2, sharing }
}

test('verified owners publish password links and a native form gets a bounded signed download', async () => {
  const { send, login, ready } = fixture()
  const owner = await login('owner@example.test')
  const file = ready(owner.id),
    expiresAt = Date.now() + 60_000
  expect((await send('/api/transfers/files')).status).toBe(401)
  expect(
    (await send('/api/shares', 'POST', '', { kind: 'request' })).status,
  ).toBe(401)
  expect(
    (
      await send('/api/shares', 'POST', owner.cookie, {
        kind: 'request',
        ownerId: 'other',
      })
    ).status,
  ).toBe(400)
  const created = await send('/api/shares', 'POST', owner.cookie, {
    kind: 'file',
    fileId: file.id,
    alias: 'notes',
    access: 'password',
    password: 'our notes',
    expiresAt,
  })
  expect(created.status).toBe(201)
  const row = (await created.json()) as { id: string }
  expect(row).toMatchObject({
    href: '/s/notes',
    fileId: file.id,
    kind: 'file',
    access: 'password',
  })
  const endpoint = '/api/links/notes'
  expect(await (await send(endpoint)).json()).toEqual({
    alias: 'notes',
    kind: 'file',
    access: 'password',
    authorized: false,
  })
  expect((await send(endpoint + '/download')).status).toBe(401)
  const retry = await send(
    endpoint + '/download',
    'POST',
    '',
    new URLSearchParams({ password: 'incorrect' }),
  )
  expect(retry.status).toBe(303)
  expect(retry.headers.get('Location')).toBe('/s/notes?error=password')
  const download = await send(
    endpoint + '/download',
    'POST',
    '',
    new URLSearchParams({ password: 'our notes' }),
  )
  expect(download.status).toBe(303)
  expect(download.body).toBeNull()
  expect(download.headers.get('Referrer-Policy')).toBe('no-referrer')
  const storage = new URL(download.headers.get('Location') ?? '')
  expect(storage.hostname).toEndWith('.r2.cloudflarestorage.com')
  expect(storage.pathname).toEndWith('/' + file.key)
  expect(storage.searchParams.has('X-Amz-Signature')).toBe(true)
  expect(Number(storage.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(
    60,
  )
  expect(
    (await send('/api/shares/' + row.id, 'DELETE', owner.cookie)).status,
  ).toBe(204)
  expect((await send(endpoint)).status).toBe(404)
})

test('verified links reveal file metadata only to signed-in recipients; requests never offer a download', async () => {
  const { send, login, ready } = fixture()
  const owner = await login('alice@example.test'),
    recipient = await login('bob@example.test')
  const file = ready(owner.id)
  const share = await send('/api/shares', 'POST', owner.cookie, {
    kind: 'file',
    fileId: file.id,
    alias: 'team',
    access: 'verified',
  })
  const data = (await share.json()) as { id: string }
  expect(await (await send('/api/links/team')).json()).toEqual({
    kind: 'file',
    access: 'verified',
    alias: 'team',
    authorized: false,
  })
  const authorized = await (
    await send('/api/links/team', 'GET', recipient.cookie)
  ).json()
  expect(authorized).toEqual({
    kind: 'file',
    access: 'verified',
    alias: 'team',
    authorized: true,
    name: file.name,
    size: file.size,
    expiresAt: file.expiresAt,
  })
  expect(
    (await send('/api/links/team/download', 'GET', recipient.cookie)).status,
  ).toBe(303)
  expect(
    (await send('/api/shares/' + data.id, 'DELETE', recipient.cookie)).status,
  ).toBe(404)
  expect(
    await (await send('/api/shares', 'GET', recipient.cookie)).json(),
  ).toEqual({ shares: [] })
  const request = await send('/api/shares', 'POST', owner.cookie, {
    kind: 'request',
    alias: 'inbox',
  })
  expect(request.status).toBe(201)
  const drop = (await request.json()) as { id: string }
  expect(drop).toMatchObject({
    kind: 'request',
    href: '/r/inbox',
    fileId: null,
    access: 'verified',
  })
  expect(
    await (await send('/api/shares', 'GET', owner.cookie)).json(),
  ).toMatchObject({
    shares: expect.arrayContaining([
      drop,
      expect.objectContaining({ href: '/s/team', id: data.id }),
    ]),
  })
  expect(
    (
      await send('/api/shares', 'POST', owner.cookie, {
        kind: 'request',
        target: { mountId: 'files', segments: [] },
      })
    ).status,
  ).toBe(400)
  expect(await (await send('/api/links/inbox')).json()).toEqual({
    alias: 'inbox',
    kind: 'request',
    access: 'verified',
    authorized: false,
  })
  expect(
    await (await send('/api/links/inbox', 'GET', recipient.cookie)).json(),
  ).toEqual({
    alias: 'inbox',
    kind: 'request',
    access: 'verified',
    authorized: true,
  })
  expect(
    (await send('/api/links/inbox/download', 'GET', recipient.cookie)).status,
  ).toBe(404)
  expect(
    (
      await send('/api/transfers/uploads', 'POST', '', {
        name: 'drop.txt',
        size: 5,
        requestAlias: 'inbox',
      })
    ).status,
  ).toBe(401)
})
