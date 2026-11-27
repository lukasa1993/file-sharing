import {
  emailAddress,
  sendVerificationCode,
  type CloudMailEnv,
} from './mail.ts'

// The native SQLite-backed Durable Object surface used by this module.
export interface CloudAuthStorage {
  sql: {
    exec<
      T extends Record<string, string | number | null> = Record<
        string,
        string | number | null
      >,
    >(
      query: string,
      ...bindings: (string | number | null)[]
    ): { toArray(): T[] }
  }
  transactionSync<T>(work: () => T): T
}
export type CloudUser = { id: string; email: string }
const minute = 60_000
const codeLifetime = 10 * minute
const sessionLifetime = 7 * 24 * 60 * minute
const sessionCookie = '__Host-lshare-session'
const challengeCookie = '__Host-lshare-verification'
const utf8 = new TextEncoder()

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

function secret() {
  return hex(crypto.getRandomValues(new Uint8Array(32)))
}

async function digest(text: string) {
  return hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(text))),
  )
}

function verificationCode() {
  const range = 100_000_000
  const limit = Math.floor(2 ** 32 / range) * range
  const bytes = new Uint8Array(4)
  const view = new DataView(bytes.buffer)
  let word: number
  do {
    crypto.getRandomValues(bytes)
    word = view.getUint32(0)
  } while (word >= limit)
  return (word % range).toString().padStart(8, '0')
}

function readCookie(request: Request, name: string) {
  const pieces = (request.headers.get('Cookie') ?? '')
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(name + '='))
  const [piece] = pieces
  if (pieces.length !== 1 || !piece) return null
  const value = piece.slice(name.length + 1)
  return /^[a-f0-9]{64}$/.test(value) ? value : null
}

function cookie(name: string, value: string, lifetime: number) {
  return (
    name +
    '=' +
    value +
    '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' +
    Math.floor(lifetime / 1000)
  )
}

function reply(status: number, value: unknown, cookies: string[] = []) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
  for (const value of cookies) headers.append('Set-Cookie', value)
  return Response.json(value, { status, headers })
}

async function form(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  if (
    (request.headers.get('Content-Type') ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase() !== 'application/json'
  )
    return reply(415, { error: 'Use an application/json request.' })
  if (Number(request.headers.get('Content-Length')) > 2048)
    return reply(413, { error: 'Request is too large.' })
  const reader = request.body?.getReader()
  if (reader) {
    const bytes = new Uint8Array(2048)
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (chunk.value.byteLength > bytes.length - size) {
          await reader.cancel()
          return reply(413, { error: 'Request is too large.' })
        }
        bytes.set(chunk.value, size)
        size += chunk.value.length
      }
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          bytes.subarray(0, size),
        ),
      )
      if (typeof value === 'object' && value !== null && !Array.isArray(value))
        return value as Record<string, unknown>
    } catch {
      return reply(400, { error: 'Enter a valid JSON object.' })
    } finally {
      reader.releaseLock()
    }
  }
  return reply(400, { error: 'Enter a valid JSON object.' })
}

type Budget = { key: string; limit: number; period: number }

export class CloudIdentity {
  private nextSweep = 0

  constructor(
    private readonly storage: CloudAuthStorage,
    private readonly now: () => number = Date.now,
  ) {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cloud_auth_users(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_auth_codes(flow TEXT PRIMARY KEY, email TEXT NOT NULL, proof TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS cloud_auth_codes_expires ON cloud_auth_codes(expires);
      CREATE TABLE IF NOT EXISTS cloud_auth_sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS cloud_auth_sessions_expires ON cloud_auth_sessions(expires);
      CREATE TABLE IF NOT EXISTS cloud_auth_limits(bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS cloud_auth_limits_expires ON cloud_auth_limits(expires);`)
  }

  private sweep(time: number) {
    if (time < this.nextSweep) return
    this.storage.sql.exec('DELETE FROM cloud_auth_codes WHERE expires<=?', time)
    this.storage.sql.exec(
      'DELETE FROM cloud_auth_sessions WHERE expires<=?',
      time,
    )
    this.storage.sql.exec(
      'DELETE FROM cloud_auth_limits WHERE expires<=?',
      time,
    )
    this.nextSweep = time + minute
  }

  private takeBudget(budgets: Budget[], time: number) {
    return this.storage.transactionSync(() => {
      for (const budget of budgets) {
        const [row] = this.storage.sql
          .exec<{ count: number; expires: number }>(
            'SELECT count,expires FROM cloud_auth_limits WHERE bucket=?',
            budget.key,
          )
          .toArray()
        if (row && row.expires > time && row.count >= budget.limit) return false
      }
      for (const budget of budgets) {
        this.storage.sql.exec(
          `INSERT INTO cloud_auth_limits(bucket,count,expires) VALUES(?,1,?)
          ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,
          expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END`,
          budget.key,
          time + budget.period,
          time,
          time,
        )
      }
      return true
    })
  }

  async current(request: Request): Promise<CloudUser | null> {
    const token = readCookie(request, sessionCookie)
    if (!token) return null
    const key = await digest(token)
    return (
      this.storage.sql
        .exec<CloudUser>(
          `SELECT u.id,u.email FROM cloud_auth_sessions s JOIN cloud_auth_users u ON u.id=s.user_id
      WHERE s.token=? AND s.expires>?`,
          key,
          this.now(),
        )
        .toArray()[0] ?? null
    )
  }

  async handle(
    request: Request,
    env: CloudMailEnv,
    peer?: string,
  ): Promise<Response> {
    const url = new URL(request.url)
    const action = url.pathname
    if (action === '/api/auth/me') {
      if (request.method !== 'GET') return reply(405, { error: 'Use GET.' })
      return reply(200, { user: await this.current(request) })
    }
    if (
      !['/api/auth/start', '/api/auth/verify', '/api/auth/logout'].includes(
        action,
      )
    )
      return reply(404, { error: 'Page not found.' })
    if (request.method !== 'POST') return reply(405, { error: 'Use POST.' })
    if (request.headers.get('Origin') !== url.origin)
      return reply(403, { error: 'Use this app to submit the request.' })
    const fields = await form(request)
    if (fields instanceof Response) return fields
    const time = this.now()
    this.sweep(time)
    if (action === '/api/auth/logout') {
      const token = readCookie(request, sessionCookie)
      if (token)
        this.storage.sql.exec(
          'DELETE FROM cloud_auth_sessions WHERE token=?',
          await digest(token),
        )
      const flow = readCookie(request, challengeCookie)
      if (flow)
        this.storage.sql.exec(
          'DELETE FROM cloud_auth_codes WHERE flow=?',
          await digest(flow),
        )
      return reply(200, { ok: true }, [
        cookie(sessionCookie, '', 0),
        cookie(challengeCookie, '', 0),
      ])
    }
    const email = emailAddress(fields.email)
    if (!email) return reply(400, { error: 'Enter a valid email address.' })
    const isStart = action === '/api/auth/start'
    const [emailKey, peerKey] = await Promise.all([
      digest(email),
      digest((peer || 'unknown').slice(0, 128)),
    ])
    const prefix = isStart ? 'start:' : 'verify:'
    const limits = [
      {
        key: prefix + 'email:' + emailKey,
        limit: isStart ? 3 : 15,
        period: 15 * minute,
      },
      {
        key: prefix + 'peer:' + peerKey,
        limit: isStart ? 15 : 60,
        period: 15 * minute,
      },
      {
        key: prefix + 'global',
        limit: isStart ? 120 : 600,
        period: 15 * minute,
      },
    ]
    if (isStart)
      limits.push({ key: 'start:day', limit: 500, period: 24 * 60 * minute })
    if (!this.takeBudget(limits, time))
      return reply(429, { error: 'Too many attempts. Try again later.' })
    if (isStart) return this.start(request, env, email)
    return this.verify(request, email, fields.code)
  }

  private async start(request: Request, env: CloudMailEnv, email: string) {
    const flow = secret()
    const code = verificationCode()
    const previous = readCookie(request, challengeCookie)
    const [key, proof, old] = await Promise.all([
      digest(flow),
      digest(flow + ':' + code),
      previous ? digest(previous) : null,
    ])
    try {
      await sendVerificationCode(env, email, code)
    } catch {
      return reply(503, {
        error: 'Email sign-in is temporarily unavailable. Try again later.',
      })
    }
    this.storage.transactionSync(() => {
      if (old)
        this.storage.sql.exec('DELETE FROM cloud_auth_codes WHERE flow=?', old)
      this.storage.sql.exec(
        'INSERT INTO cloud_auth_codes(flow,email,proof,expires,attempts) VALUES(?,?,?,?,5)',
        key,
        email,
        proof,
        this.now() + codeLifetime,
      )
    })
    return reply(202, { ok: true }, [
      cookie(challengeCookie, flow, codeLifetime),
    ])
  }

  private async verify(request: Request, email: string, input: unknown) {
    const denied = () =>
      reply(401, { error: 'The verification code is invalid or expired.' })
    const flow = readCookie(request, challengeCookie)
    if (!flow || typeof input !== 'string' || !/^\d{8}$/.test(input))
      return denied()
    const token = secret()
    const previous = readCookie(request, sessionCookie)
    const [challenge, proof, key, old] = await Promise.all([
      digest(flow),
      digest(flow + ':' + input),
      digest(token),
      previous ? digest(previous) : null,
    ])
    const user = this.storage.transactionSync(() => {
      const time = this.now()
      const [row] = this.storage.sql
        .exec<{ proof: string }>(
          `UPDATE cloud_auth_codes SET attempts=attempts-1
        WHERE flow=? AND email=? AND expires>? AND attempts>0 RETURNING proof`,
          challenge,
          email,
          time,
        )
        .toArray()
      if (!row || row.proof !== proof) return null
      this.storage.sql.exec(
        'DELETE FROM cloud_auth_codes WHERE flow=?',
        challenge,
      )
      this.storage.sql.exec(
        'INSERT INTO cloud_auth_users(id,email,created) VALUES(?,?,?) ON CONFLICT(email) DO NOTHING',
        crypto.randomUUID(),
        email,
        time,
      )
      const [account] = this.storage.sql
        .exec<CloudUser>(
          'SELECT id,email FROM cloud_auth_users WHERE email=?',
          email,
        )
        .toArray()
      if (!account) throw new Error('Could not register this account.')
      if (old)
        this.storage.sql.exec(
          'DELETE FROM cloud_auth_sessions WHERE token=?',
          old,
        )
      this.storage.sql.exec(
        'INSERT INTO cloud_auth_sessions(token,user_id,expires) VALUES(?,?,?)',
        key,
        account.id,
        time + sessionLifetime,
      )
      return account
    })
    if (!user) return denied()
    return reply(200, { user }, [
      cookie(sessionCookie, token, sessionLifetime),
      cookie(challengeCookie, '', 0),
    ])
  }
}
