import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  CloudIdentity,
  type CloudAuthStorage,
  type CloudUser,
} from '../../cloudflare/identity.ts'
import {
  emailAddress,
  sendCapacityAlert,
  type CloudMailEnv,
} from '../../cloudflare/mail.ts'

const origin = 'https://files.example.test'
const address = 'reader@example.test'
type Message = { from: string; to: string; subject: string; text: string }
let box: Message[],
  db: Database,
  storage: CloudAuthStorage,
  env: CloudMailEnv,
  identity: CloudIdentity,
  instant: number

beforeEach(() => {
  box = []
  instant = 1_700_000_000_000
  db = new Database(':memory:')
  storage = {
    sql: {
      exec<T extends Record<string, string | number | null>>(
        query: string,
        ...bindings: (string | number | null)[]
      ) {
        if (!bindings.length && query.includes('CREATE TABLE')) {
          db.exec(query)
          return { toArray: (): T[] => [] }
        }
        // Native SqlStorage.exec performs writes immediately, without consuming a cursor.
        const rows = db
          .query<T, (string | number | null)[]>(query)
          .all(...bindings)
        return { toArray: () => rows }
      },
    },
    transactionSync: (work) => db.transaction(work)(),
  }
  identity = new CloudIdentity(storage, () => instant)
  env = {
    MAIL_FROM: 'signin@example.test',
    ALERT_EMAIL: 'ops@example.test',
    EMAIL: {
      send: async (message) => {
        box.push(message)
        return { messageId: 'fixture' }
      },
    },
  }
})
afterEach(() => db.close())

function post(
  action: string,
  fields: unknown,
  cookie = '',
  peer = '192.0.2.7',
) {
  return identity.handle(
    new Request(origin + '/api/auth/' + action, {
      method: 'POST',
      headers: {
        Origin: origin,
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(fields),
    }),
    env,
    peer,
  )
}
function cookieOf(response: Response, name: string) {
  const value = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith('__Host-lshare-' + name + '='))
  if (!value) throw new Error('The expected cookie was missing.')
  return value.split(';')[0]!
}
async function start(email = address, old = '') {
  const response = await post('start', { email }, old)
  expect(response.status).toBe(202)
  expect(await response.json()).toEqual({ ok: true })
  const code = box.at(-1)?.text.match(/sign-in code is ([0-9]{8})\./)?.[1]
  if (!code) throw new Error('Expected eight digits in the fixture mailbox.')
  return { cookie: cookieOf(response, 'verification'), code }
}
function me(cookie = '') {
  return new Request(origin + '/api/auth/me', { headers: { Cookie: cookie } })
}

test('registers only after email verification, rotates sessions, and revokes logout across restarts', async () => {
  expect(await (await identity.handle(me(), env)).json()).toEqual({
    user: null,
  })
  const challenge = await start(' Reader@Example.test ')
  expect(box[0]).toMatchObject({
    to: address,
    from: 'signin@example.test',
    subject: 'Your lshare sign-in code',
  })
  expect(db.query('SELECT id FROM cloud_auth_users').all()).toEqual([])
  const stored = db
    .query<{ flow: string; proof: string }, []>(
      'SELECT flow,proof FROM cloud_auth_codes',
    )
    .get()!
  expect(stored.flow).toHaveLength(64)
  expect(stored.proof).toHaveLength(64)
  expect(challenge.cookie).not.toContain(stored.flow)
  const verified = await post(
    'verify',
    { email: address, code: challenge.code },
    challenge.cookie,
  )
  expect(verified.status).toBe(200)
  const { user } = (await verified.json()) as { user: CloudUser }
  expect(user.email).toBe(address)
  expect(user.id).toHaveLength(36)
  const header = verified.headers
    .getSetCookie()
    .find((item) => item.startsWith('__Host-lshare-session='))
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/'])
    expect(header).toContain(flag)
  const session = cookieOf(verified, 'session')
  const saved = db
    .query<{ token: string }, []>('SELECT token FROM cloud_auth_sessions')
    .get()!
  expect(saved.token).toHaveLength(64)
  expect(session).not.toContain(saved.token)
  identity = new CloudIdentity(storage, () => instant)
  expect(await identity.current(me(session))).toEqual(user)
  const second = await start()
  const rotated = await post(
    'verify',
    { email: address, code: second.code },
    session + '; ' + second.cookie,
  )
  expect(((await rotated.json()) as { user: CloudUser }).user.id).toBe(user.id)
  expect(await identity.current(me(session))).toBeNull()
  const next = cookieOf(rotated, 'session')
  expect(await identity.current(me(next))).toEqual(user)
  const out = await post('logout', {}, next)
  expect(out.status).toBe(200)
  expect(
    out.headers.getSetCookie().every((value) => value.includes('Max-Age=0')),
  ).toBe(true)
  expect(await identity.current(me(next))).toBeNull()
})

test('verification belongs to one browser and address and expires after ten minutes', async () => {
  const first = await start()
  const verify = (email: string, cookie: string) =>
    post('verify', { email, code: first.code }, cookie)
  expect((await verify(address, '')).status).toBe(401)
  expect((await verify('other@example.test', first.cookie)).status).toBe(401)
  const responses = await Promise.all([
    verify(address, first.cookie),
    verify(address, first.cookie),
  ])
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 401,
  ])
  const session = cookieOf(
    responses.find((response) => response.status === 200)!,
    'session',
  )
  const second = await start()
  instant += 10 * 60_000
  expect(
    (await post('verify', { email: address, code: second.code }, second.cookie))
      .status,
  ).toBe(401)
  instant += 7 * 24 * 60 * 60_000
  expect(await identity.current(me(session))).toBeNull()
})

test('resending replaces the prior code and five incorrect entries consume a challenge', async () => {
  const first = await start()
  const second = await start(address, first.cookie)
  expect(
    (await post('verify', { email: address, code: first.code }, first.cookie))
      .status,
  ).toBe(401)
  const wrong = second.code === '00000000' ? '00000001' : '00000000'
  for (let i = 0; i < 5; i++)
    expect(
      (await post('verify', { email: address, code: wrong }, second.cookie))
        .status,
    ).toBe(401)
  expect(
    (await post('verify', { email: address, code: second.code }, second.cookie))
      .status,
  ).toBe(401)
  expect(db.query('SELECT id FROM cloud_auth_users').all()).toEqual([])
})

test('durable delivery budgets cover an email address, peer, global window and daily total', async () => {
  const send = (email: string) => post('start', { email })
  for (let i = 0; i < 3; i++) expect((await send(address)).status).toBe(202)
  expect((await send(address)).status).toBe(429)
  identity = new CloudIdentity(storage, () => instant)
  expect((await send(address)).status).toBe(429)
  // Set up prior ordinary traffic without generating additional messages.
  db.query(
    "UPDATE cloud_auth_limits SET count=15 WHERE bucket LIKE 'start:peer:%'",
  ).run()
  expect((await send('other@example.test')).status).toBe(429)
  db.query(
    "UPDATE cloud_auth_limits SET count=0 WHERE bucket LIKE 'start:peer:%'",
  ).run()
  db.query(
    "UPDATE cloud_auth_limits SET count=120 WHERE bucket='start:global'",
  ).run()
  expect((await send('other@example.test')).status).toBe(429)
  expect(box).toHaveLength(3)
  instant += 15 * 60_000
  expect((await send(address)).status).toBe(202)
  db.query(
    "UPDATE cloud_auth_limits SET count=500 WHERE bucket='start:day'",
  ).run()
  expect((await send('other@example.test')).status).toBe(429)
})

test('the auth endpoints accept same-origin JSON writes and keep provider errors private', async () => {
  const send = (
    originHeader: string | undefined,
    contentType: string,
    body: string,
  ) =>
    identity.handle(
      new Request(origin + '/api/auth/start', {
        method: 'POST',
        headers: {
          ...(originHeader ? { origin: originHeader } : {}),
          'content-type': contentType,
        },
        body,
      }),
      env,
    )
  expect((await send(undefined, 'application/json', '{}')).status).toBe(403)
  expect(
    (await send('https://other.example.test', 'application/json', '{}')).status,
  ).toBe(403)
  expect((await send(origin, 'text/plain', '{}')).status).toBe(415)
  expect((await send(origin, 'application/json', '{')).status).toBe(400)
  expect(
    (await send(origin, 'application/json', ' '.repeat(2100))).status,
  ).toBe(413)
  expect((await post('start', { email: 'bad-address' })).status).toBe(400)
  env.EMAIL = {
    send: async () => {
      throw new Error('fixture-private-provider-detail')
    },
  }
  const failed = await post('start', { email: address })
  expect(failed.status).toBe(503)
  expect(await failed.text()).not.toContain('fixture-private-provider-detail')
  expect(failed.headers.getSetCookie()).toEqual([])
  expect(db.query('SELECT flow FROM cloud_auth_codes').all()).toEqual([])
  expect(db.query('SELECT id FROM cloud_auth_users').all()).toEqual([])
})

test('capacity mail uses the configured operator and validates single mailboxes', async () => {
  expect(emailAddress(' First+files@Example.Test ')).toBe(
    'first+files@example.test',
  )
  for (const bad of [
    'two..dots@example.test',
    'x@-invalid.test',
    'a@example.test,b@example.test',
    'a@example.test\nX-Header: extra',
  ])
    expect(emailAddress(bad)).toBeNull()
  await sendCapacityAlert(env, 'Storage usage reached 90%.')
  expect(box).toEqual([
    {
      from: 'signin@example.test',
      to: 'ops@example.test',
      subject: 'lshare capacity alert',
      text: 'Storage usage reached 90%.',
    },
  ])
  await expect(sendCapacityAlert({}, 'Capacity reached.')).rejects.toThrow(
    'recipient',
  )
  await expect(
    sendCapacityAlert({ ALERT_EMAIL: 'ops@example.test' }, 'Capacity reached.'),
  ).rejects.toThrow('unavailable')
})
