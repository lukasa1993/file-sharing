import { Clock, Effect, Option, Ref, Semaphore } from 'effect'
import { asAppError, attempt, runTask } from '../effects.ts'
import type { Database } from 'bun:sqlite'
import { randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import {
  completeAuth,
  startExternalAuth,
  finishExternalAuth,
  createCredentialsAuthProvider,
  verifyCredentials,
} from 'remix/auth'
import { createCookie } from 'remix/cookie'
import { Auth, auth, createSessionAuthScheme } from 'remix/middleware/auth'
import { session as sessionMiddleware } from 'remix/middleware/session'
import { csrf, getCsrfToken } from 'remix/middleware/csrf'
import { RequestContext } from 'remix/router'
import { Session } from 'remix/session'
import {
  actions,
  AppError,
  type Action,
  type AppConfig,
  type ResourceRef,
  type User,
} from '../contracts.ts'
import { absoluteAge, digest, SqliteSessions } from './session.ts'
import { OidcProvider } from './oidc.ts'
import { initializeIdentitySchema } from './schema.ts'
import { permittedByDirectoryGrant } from './directory-permissions.ts'

export interface Access {
  user: User | null
  csrf: string
  sessionId: string | null
  setCookie?: string
  bearer: boolean
}
type Fields = Record<string, unknown>
type Account = {
  id: string
  username: string
  admin: number
  enabled: number
  passwordHash: string
}
type TokenRow = { id: string; userId: string; scope: string; expiresAt: number }
function isUser(value: unknown): value is User {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'username' in value &&
    typeof value.username === 'string' &&
    'admin' in value &&
    typeof value.admin === 'boolean'
  )
}

const hashOptions = {
  algorithm: 'argon2id',
  memoryCost: 32768,
  timeCost: 3,
} as const
function missingHash(): never {
  throw new Error('Password hash was not prepared.')
}
const bad = (message: string) => new AppError(400, message)
const forbidden = () => new AppError(403, 'Access denied.')
const emptyResponse = async () => new Response(null, { status: 204 })
const namePattern = /^[\p{L}\p{N}_.@+-]{1,96}$/u
const readTokenRoutes = new Set([
  '/_/api/v1/entries',
  '/_/download',
  '/_/preview',
])
function text(fields: Fields, name: string, max = 160) {
  const v = fields[name]
  if (typeof v !== 'string' || !v || Buffer.byteLength(v) > max)
    throw bad('Invalid ' + name + '.')
  return v
}
function booleanValue(v: unknown) {
  if (v === true || v === 'true' || v === '1' || v === 'on') return true
  if (v === false || v === 'false' || v === '0' || v === undefined || v === '')
    return false
  throw bad('Invalid switch value.')
}
// Store only coarse, self-reported device information so a user can recognize a session.
function deviceLabel(agent: string | null) {
  const value = (agent ?? '').slice(0, 512)
  const browser = /Edg(?:e|A|iOS)?\//.test(value)
    ? 'Edge'
    : /Firefox\/|FxiOS\//.test(value)
      ? 'Firefox'
      : /Chrome\/|Chromium\/|CriOS\//.test(value)
        ? 'Chrome'
        : /Safari\//.test(value)
          ? 'Safari'
          : undefined
  const platform = /Android/.test(value)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(value)
      ? 'iOS'
      : /Windows/.test(value)
        ? 'Windows'
        : /CrOS/.test(value)
          ? 'ChromeOS'
          : /Macintosh|Mac OS X/.test(value)
            ? 'macOS'
            : /Linux/.test(value)
              ? 'Linux'
              : undefined
  return [browser, platform].filter(Boolean).join(' on ') || 'Unknown device'
}

const sessionFields = `publicId AS id,userId,createdAt,lastSeen,id=? AS current,
  CASE WHEN json_valid(data) THEN json_extract(data,'$[0].device') END AS device`

function validPassword(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    Buffer.byteLength(v) >= 12 &&
    Buffer.byteLength(v) <= 1024
  )
}
function validSegment(s: string) {
  return (
    !!s &&
    s !== '.' &&
    s !== '..' &&
    !/[\/\\\x00-\x1f]/.test(s) &&
    Buffer.byteLength(s) <= 255
  )
}
function validatePath(raw: unknown) {
  if (raw === undefined || raw === null || raw === '' || raw === '/') return ''
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096)
    throw bad('Invalid directory.')
  const path = raw.replace(/^\//, '')
  if (!path.split('/').every(validSegment)) throw bad('Invalid directory.')
  return path
}

function bootstrapCredentials(file: string) {
  return Effect.acquireUseRelease(
    attempt(() =>
      open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ),
    ),
    (handle) =>
      attempt(async () => {
        const st = await handle.stat()
        if (
          !st.isFile() ||
          (st.mode & 0o077) !== 0 ||
          st.nlink !== 1 ||
          st.size > 8192 ||
          (st.uid !== 0 && st.uid !== process.getuid?.())
        ) {
          throw new Error(
            'Bootstrap file must be a private regular file owned by the service or root.',
          )
        }
        const buf = Buffer.alloc(8193)
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
        if (bytesRead !== st.size)
          throw new Error('Could not read the complete bootstrap file.')
        let data: Fields
        try {
          data = JSON.parse(buf.toString('utf8', 0, bytesRead))
        } catch (cause) {
          throw new Error('Invalid bootstrap JSON.', { cause })
        }
        if (
          !data ||
          typeof data.username !== 'string' ||
          !namePattern.test(data.username) ||
          !validPassword(data.password)
        ) {
          throw new Error(
            'Bootstrap requires a valid username and a password of 12–1024 bytes.',
          )
        }
        return { username: data.username, password: data.password }
      }),
    (handle) => attempt(() => handle.close()),
  )
}

async function submittedToken(request: Request) {
  const header = request.headers.get('X-CSRF-Token')
  if (header !== null) return header.length <= 256 ? header : null
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/x-www-form-urlencoded')
  )
    return null
  const max = 65536
  if (Number(request.headers.get('content-length') || 0) > max)
    throw new AppError(413, 'Form is too large.')
  const reader = request.clone().body?.getReader()
  if (!reader) return null
  const pieces: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        // Rejecting the request releases both halves of the cloned body.
        await Promise.all([reader.cancel(), request.body?.cancel()])
        throw new AppError(413, 'Form is too large.')
      }
      pieces.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const fields = new URLSearchParams(Buffer.concat(pieces).toString('utf8'))
  return fields.get('csrf') ?? fields.get('_csrf')
}

export class Identity {
  readonly storage: SqliteSessions
  private cookie: ReturnType<typeof createCookie>
  private requestContexts = new WeakMap<Access, RequestContext>()
  private tokenScopes = new WeakMap<User, string>()
  private contextsByUser = new WeakMap<User, string>()
  private readonly rateWindow = Ref.makeUnsafe({
    minute: -1,
    counts: new Map<string, number>(),
  })
  private readonly hashSlots = Semaphore.makeUnsafe(3)
  private readonly oidc: OidcProvider | undefined
  private readonly bandwidthLimits = new Map<string, number>()
  private dummy = ''
  private readonly sessionScheme = createSessionAuthScheme<User, string>({
    read: (session) => {
      const id = session.get('userId')
      return typeof id === 'string' ? id : undefined
    },
    verify: (id) => this.getUser(id),
  })

  private readonly authenticate = auth({ schemes: [this.sessionScheme] })
  private readonly loadSession: ReturnType<typeof sessionMiddleware>

  constructor(
    readonly db: Database,
    readonly config: AppConfig,
    private clock: Clock.Clock = Clock.Clock.defaultValue(),
  ) {
    this.oidc = config.oidc
      ? new OidcProvider(config.oidc, config.publicOrigin, clock)
      : undefined
    this.storage = new SqliteSessions(db, clock)
    this.cookie = createCookie('fs_session', {
      secrets: [config.sessionSecret],
      httpOnly: true,
      path: '/',
      sameSite: 'Lax',
      secure: new URL(config.publicOrigin).protocol === 'https:',
    })
    this.loadSession = sessionMiddleware(this.cookie, this.storage)
  }

  async init() {
    initializeIdentitySchema(this.db)
    this.bandwidthLimits.clear()
    for (const row of this.db
      .query<{ userId: string; rate: number }, []>(
        'SELECT userId,rate FROM auth_user_bandwidth',
      )
      .all())
      this.bandwidthLimits.set(row.userId, row.rate)
    this.dummy = await Bun.password.hash(
      randomBytes(32).toString('hex'),
      hashOptions,
    )
    if (this.db.query('SELECT 1 FROM auth_users LIMIT 1').get()) return
    if (!this.config.bootstrapFile)
      throw new Error(
        'A private BOOTSTRAP_FILE is required to provision the first administrator.',
      )
    const { username, password } = await runTask(
      bootstrapCredentials(this.config.bootstrapFile),
    )
    const hash = await Bun.password.hash(password, hashOptions)
    this.db
      .transaction(() => {
        if (!this.db.query('SELECT 1 FROM auth_users LIMIT 1').get()) {
          this.db
            .query(
              'INSERT INTO auth_users(id,username,passwordHash,admin) VALUES (?,?,?,1)',
            )
            .run(randomUUID(), username, hash)
          this.audit(null, 'admin.bootstrap')
        }
      })
      .immediate()
  }

  getUser(id: string): User | null {
    const row = this.db
      .query<Pick<Account, 'id' | 'username' | 'admin'>, [string]>(
        'SELECT id,username,admin FROM auth_users WHERE id=? AND enabled=1',
      )
      .get(id)
    return row
      ? { id: row.id, username: row.username, admin: Boolean(row.admin) }
      : null
  }

  bandwidthBudget(id: string) {
    return { key: id, rate: () => this.bandwidthLimits.get(id) ?? 0 }
  }

  quota(id: string) {
    return (
      this.db
        .query<{ quota: number | null }, [string]>(
          'SELECT quota FROM auth_users WHERE id=? AND enabled=1',
        )
        .get(id)?.quota ?? null
    )
  }

  sessionActive(id: string) {
    return this.storage.active(id)
  }

  private liveUser(user: User, action?: Action): User | null {
    const tokenId = this.tokenScopes.get(user)
    if (tokenId) {
      const token = this.db
        .query<TokenRow, [string]>(
          'SELECT id,userId,scope,expiresAt FROM auth_tokens WHERE id=?',
        )
        .get(tokenId)
      if (
        !token ||
        token.expiresAt <= this.clock.currentTimeMillisUnsafe() ||
        (action && !token.scope.split(',').includes(action))
      )
        return null
    }
    const sessionId = this.contextsByUser.get(user)
    if (sessionId && !this.sessionActive(sessionId)) return null
    return this.getUser(user.id)
  }

  isCurrent(user: User): boolean {
    return this.liveUser(user) !== null
  }

  home(user: User): ResourceRef | null {
    if (!this.isCurrent(user)) return null
    const row = this.db
      .query<{ mountId: string; path: string }, [string]>(
        'SELECT mountId,path FROM auth_homes WHERE userId=?',
      )
      .get(user.id)
    return row ? { mountId: row.mountId, segments: row.path.split('/') } : null
  }

  entryPoints(user: User): ResourceRef[] {
    if (!this.liveUser(user, 'list')) return []
    const candidates: ResourceRef[] = this.config.mounts.map((mount) => ({
      mountId: mount.id,
      segments: [],
    }))
    const home = this.home(user)
    if (home) candidates.push(home)
    const grants = this.db
      .query<{ mountId: string; path: string }, [string, string]>(
        `
      SELECT distinct mountId,path FROM (
        SELECT mountId,path,permission,subjectType,subjectId FROM auth_grants WHERE effect='allow'
        UNION ALL
        SELECT mountId,path,permission,subjectType,subjectId FROM auth_directory_grants
      )
      WHERE permission='list' AND ((subjectType='user' AND subjectId=?) OR
        (subjectType='group' AND subjectId IN (SELECT groupId FROM auth_members WHERE userId=?)))
      ORDER BY mountId,path`,
      )
      .all(user.id, user.id)
    for (const grant of grants)
      candidates.push({
        mountId: grant.mountId,
        segments: grant.path ? grant.path.split('/') : [],
      })
    candidates.sort(
      (left, right) => left.segments.length - right.segments.length,
    )
    const anchors = new Map<string, ResourceRef>()
    const access = new Map<string, boolean>()
    for (const candidate of candidates) {
      let segments = candidate.segments
      for (;;) {
        const key = JSON.stringify([candidate.mountId, ...segments])
        if (anchors.has(key)) break
        let visible = access.get(key)
        if (visible === undefined) {
          visible = this.allowed(user, 'list', {
            mountId: candidate.mountId,
            segments,
          })
          access.set(key, visible)
        }
        if (!visible || !segments.length) {
          if (visible || segments.length < candidate.segments.length)
            anchors.set(
              JSON.stringify([candidate.mountId, ...candidate.segments]),
              candidate,
            )
          break
        }
        segments = segments.slice(0, -1)
      }
    }
    return [...anchors.values()]
  }

  allowedEffect(user: User, action: Action, ref: ResourceRef) {
    return Effect.try({
      try: () => this.evaluatePermission(user, action, ref),
      catch: asAppError,
    })
  }

  allowed(user: User, action: Action, ref: ResourceRef): boolean {
    return Effect.runSync(this.allowedEffect(user, action, ref))
  }

  private evaluatePermission(
    user: User,
    action: Action,
    ref: ResourceRef,
  ): boolean {
    const primary = this.primaryPermission(user, action, ref)
    if (primary !== null) return primary
    return (
      action !== 'manage' && permittedByDirectoryGrant(this, user, action, ref)
    )
  }

  canDelegate(user: User, action: Action, ref: ResourceRef) {
    return (
      action !== 'manage' &&
      this.primaryPermission(user, 'manage', ref) === true &&
      this.primaryPermission(user, action, ref) === true
    )
  }

  // Null means there is no effective administrator policy for this action.
  // Only that case can a folder manager supplement with a grant.
  private primaryPermission(
    user: User,
    action: Action,
    ref: ResourceRef,
  ): boolean | null {
    if (
      !user ||
      !this.config.mounts.some((m) => m.id === ref.mountId) ||
      !actions.includes(action) ||
      !Array.isArray(ref.segments) ||
      !ref.segments.every((s) => typeof s === 'string' && validSegment(s))
    )
      return false
    const fresh = this.liveUser(user, action)
    if (!fresh) return false
    const path = ref.segments.join('/')
    const home = this.db
      .query<{ userId: string; path: string }, [string, string, string]>(
        "SELECT userId,path FROM auth_homes WHERE mountId=? AND (path=? OR substr(?,1,length(path)+1)=path||'/') LIMIT 1",
      )
      .get(ref.mountId, path, path)
    const ownHome = home?.userId === user.id
    if (home && !ownHome && !fresh.admin) return false
    if (fresh.admin && (!home || ownHome || action !== 'share')) return true
    const rule = this.db
      .query<
        { effect: string },
        [string, Action, string, string, string, string, string]
      >(
        `
      SELECT effect FROM auth_grants WHERE mountId=? AND permission=?
      AND (path='' OR path=? OR substr(?,1,length(path)+1)=path||'/')
      AND length(path) >= length(?)
      AND ((subjectType='user' AND subjectId=?) OR (subjectType='group' AND subjectId IN
          (SELECT groupId FROM auth_members WHERE userId=?)))
      ORDER BY length(path) DESC,effect DESC LIMIT 1
    `,
      )
      .get(ref.mountId, action, path, path, home?.path ?? '', user.id, user.id)
    if (rule) return rule.effect === 'allow'
    return ownHome && action !== 'manage' ? true : null
  }

  async context(request: Request, createAnonymous = false): Promise<Access> {
    const authorization = request.headers.get('Authorization')
    if (authorization !== null) return this.tokenContext(request, authorization)
    const ctx = new RequestContext(request)
    const access: Access = {
      user: null,
      csrf: '',
      sessionId: null,
      bearer: false,
    }
    const response = await this.loadSession(ctx, async () => {
      return this.authenticate(ctx, async () => {
        const state = ctx.get(Auth)
        const session = ctx.get(Session)
        if (!session)
          throw new Error('Session middleware did not initialize this request.')
        if (state?.ok) {
          if (!isUser(state.identity))
            throw new Error('Invalid identity from session authentication.')
          access.user = state.identity
        }
        if (this.storage.key(session) || createAnonymous)
          access.csrf = getCsrfToken(ctx)
        return emptyResponse()
      })
    })
    const session = ctx.get(Session)
    if (session) access.sessionId = this.storage.key(session)
    if (access.user && access.sessionId)
      this.contextsByUser.set(access.user, access.sessionId)
    const setCookie = response.headers.get('Set-Cookie')
    if (setCookie) access.setCookie = setCookie
    this.requestContexts.set(access, ctx)
    return access
  }

  async current(request: Request): Promise<User | null> {
    return (await this.context(request)).user
  }

  private tokenContext(request: Request, header: string): Access {
    const match = /^Bearer (fs_[A-Za-z0-9_-]{43})$/i.exec(header)
    if (!match) throw new AppError(401, 'Invalid API token.')
    const token = this.db
      .query<TokenRow, [string]>(
        'SELECT id,userId,scope,expiresAt FROM auth_tokens WHERE digest=?',
      )
      .get(digest(header.slice(7)))
    const user =
      token && token.expiresAt > this.clock.currentTimeMillisUnsafe()
        ? this.getUser(token.userId)
        : null
    if (!user || !token) throw new AppError(401, 'Invalid API token.')
    const route = new URL(request.url).pathname
    if (
      !['GET', 'HEAD'].includes(request.method) ||
      !readTokenRoutes.has(route)
    )
      throw forbidden()
    const required = route === '/_/api/v1/entries' ? 'list' : 'read'
    if (!token.scope.split(',').includes(required)) throw forbidden()
    this.tokenScopes.set(user, token.id)
    return { user, sessionId: null, csrf: '', bearer: true }
  }

  async verifyWrite(request: Request, access: Access) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
    const ctx = this.requestContexts.get(access)
    if (
      !ctx ||
      !access.sessionId ||
      !this.sessionActive(access.sessionId) ||
      ctx.request !== request
    )
      throw forbidden()
    const origin = request.headers.get('Origin')
    if (origin && origin !== this.config.publicOrigin) throw forbidden()
    const verify = csrf({
      origin: this.config.publicOrigin,
      allowMissingOrigin: false,
      value: () => submittedToken(request),
    })
    const result = await verify(ctx, emptyResponse)
    if (!result.ok) throw forbidden()
  }

  async passwordWork<T>(work: () => Promise<T>): Promise<T> {
    return runTask(this.passwordEffect(work))
  }

  consumePasswordAttempt(key: string, peer?: string) {
    const minute = Math.floor(this.clock.currentTimeMillisUnsafe() / 60000)
    const buckets: Array<[string, number]> = [
      ['global', 120],
      ['key:' + digest(key), 12],
    ]
    if (peer) buckets.push(['peer:' + digest(peer), 30])
    const allowed = Effect.runSync(
      Ref.modify(this.rateWindow, (state) => {
        const counts =
          state.minute === minute ? state.counts : new Map<string, number>()
        if (buckets.some(([id, limit]) => (counts.get(id) ?? 0) >= limit))
          return [false, { minute, counts }]
        const next = new Map(counts)
        for (const [id] of buckets) next.set(id, (next.get(id) ?? 0) + 1)
        return [true, { minute, counts: next }]
      }),
    )
    if (!allowed)
      throw new AppError(429, 'Too many attempts. Try again shortly.')
  }

  async login(
    request: Request,
    access: Access,
    username: string,
    password: string,
    peer?: string,
  ): Promise<string> {
    const ctx = this.requestContexts.get(access)
    if (
      !ctx ||
      ctx.request !== request ||
      !access.sessionId ||
      !this.sessionActive(access.sessionId)
    )
      throw forbidden()
    if (
      typeof username !== 'string' ||
      Buffer.byteLength(username) > 160 ||
      typeof password !== 'string' ||
      Buffer.byteLength(password) > 1024
    )
      throw bad('Invalid credentials.')
    const key = username.trim()
    this.consumePasswordAttempt('login:' + key.toLowerCase(), peer)
    const provider = createCredentialsAuthProvider({
      parse: () => ({ name: key, password }),
      verify: async (input: { name: string; password: string }) => {
        const account = this.db
          .query<Account, [string]>(
            'SELECT id,username,admin,enabled,passwordHash FROM auth_users WHERE username=?',
          )
          .get(input.name)
        const ok = await this.passwordWork(() =>
          Bun.password.verify(
            input.password,
            account?.passwordHash ?? this.dummy,
          ),
        )
        if (!ok || !account?.enabled) return null
        return this.db
          .query<{ id: string }, [string, string]>(
            'SELECT id FROM auth_users WHERE id=? AND enabled=1 AND passwordHash=?',
          )
          .get(account.id, account.passwordHash)
      },
    })
    const account = await verifyCredentials(provider, ctx)
    if (!account) {
      this.audit(null, 'login.failed')
      throw new AppError(401, 'Invalid username or password.')
    }
    return this.authCookie(ctx, account.id)
  }

  private async authCookie(ctx: RequestContext, accountId: string) {
    const request = ctx.request
    const session = completeAuth(ctx)
    session.set('userId', accountId)
    session.set('device', deviceLabel(request.headers.get('User-Agent')))
    session.unset('_csrf')
    getCsrfToken(ctx)
    const value = await this.storage.save(session)
    if (!value) throw forbidden()
    this.audit(accountId, 'login.success')
    return this.cookie.serialize(value, { maxAge: absoluteAge / 1000 })
  }

  async startOidc(
    request: Request,
    access: Access,
    next: string,
    peer?: string,
  ) {
    if (!this.oidc) throw new AppError(404, 'Provider unavailable.')
    const ctx = this.requestContexts.get(access)
    if (
      !ctx ||
      ctx.request !== request ||
      access.user ||
      !access.sessionId ||
      !this.sessionActive(access.sessionId)
    )
      throw forbidden()
    this.consumePasswordAttempt('oidc-start:' + access.sessionId, peer)
    const nonce = randomBytes(32).toString('base64url')
    const session = ctx.get(Session)
    if (!session) throw forbidden()
    try {
      const provider = await this.oidc.provider(nonce, request.signal)
      const result = await startExternalAuth(provider, ctx, { returnTo: next })
      session.set('oidcNonce', nonce)
      session.set('oidcExpires', this.clock.currentTimeMillisUnsafe() + 600_000)
      await this.storage.save(session)
      return result
    } catch {
      throw new AppError(
        503,
        'Identity provider is unavailable. Sign in with your local account.',
      )
    }
  }

  async finishOidc(request: Request, access: Access) {
    if (!this.oidc || !this.config.oidc)
      throw new AppError(404, 'Provider unavailable.')
    const ctx = this.requestContexts.get(access)
    if (
      !ctx ||
      ctx.request !== request ||
      access.user ||
      !access.sessionId ||
      !this.sessionActive(access.sessionId)
    )
      throw forbidden()
    const session = ctx.get(Session)
    if (!session) throw forbidden()
    const nonce = session.get('oidcNonce'),
      expires = session.get('oidcExpires'),
      transaction = session.get('__auth')
    if (
      typeof nonce !== 'string' ||
      typeof expires !== 'number' ||
      !transaction ||
      typeof transaction !== 'object' ||
      !('state' in transaction) ||
      typeof transaction.state !== 'string' ||
      transaction.state !== ctx.url.searchParams.get('state')
    )
      throw forbidden()
    // Consume the durable transaction before contacting the issuer. A racing callback cannot revive it.
    for (const field of ['oidcNonce', 'oidcExpires', '__auth'])
      session.unset(field)
    await this.storage.save(session)
    try {
      if (expires <= this.clock.currentTimeMillisUnsafe()) throw forbidden()
      const provider = await this.oidc.provider(nonce, request.signal)
      session.set('__auth', transaction)
      const verified = await finishExternalAuth(provider, ctx)
      const mapping = this.config.oidc.accounts.find(
        (item) => item.subject === verified.result.profile.sub,
      )
      const local =
        mapping &&
        this.db
          .query<{ id: string }, [string]>(
            'SELECT id FROM auth_users WHERE username=? AND enabled=1',
          )
          .get(mapping.username)
      if (!local) throw forbidden()
      const cookie = await this.authCookie(ctx, local.id)
      return { cookie, next: verified.returnTo }
    } catch {
      this.audit(null, 'oidc.failed')
      throw forbidden()
    }
  }

  async logout(access: Access) {
    const session = this.requestContexts.get(access)?.get(Session)
    if (session) {
      session.destroy()
      await this.storage.save(session)
    }
    return this.cookie.serialize('', { maxAge: 0, expires: new Date(0) })
  }

  audit(actor: string | null, event: string) {
    this.db
      .query('INSERT INTO auth_audit(at,actor,event) VALUES (?,?,?)')
      .run(this.clock.currentTimeMillisUnsafe(), actor, event)
    this.db
      .query(
        'DELETE FROM auth_audit WHERE id <= (SELECT max(id)-2000 FROM auth_audit)',
      )
      .run()
  }

  private requireLive(user: User, admin = false) {
    const account = this.getUser(user.id)
    const session = this.contextsByUser.get(user)
    if (
      !account ||
      this.tokenScopes.has(user) ||
      (session && !this.sessionActive(session)) ||
      (admin && !account.admin)
    )
      throw forbidden()
  }

  listShareOwners(actor: User): { id: string; username: string }[] {
    this.requireLive(actor, true)
    return this.db
      .query<{ id: string; username: string }, []>(
        'SELECT id,username FROM auth_users WHERE enabled=1 ORDER BY username',
      )
      .all()
  }
  adminData(actor: User) {
    this.requireLive(actor, true)
    this.storage.sweep()
    return {
      users: this.db
        .query(
          'SELECT u.id,u.username,u.admin,u.enabled,u.quota,b.rate AS bandwidth FROM auth_users u LEFT JOIN auth_user_bandwidth b ON b.userId=u.id ORDER BY u.username',
        )
        .all(),
      groups: this.db
        .query('SELECT id,name FROM auth_groups ORDER BY name')
        .all(),
      homes: this.db
        .query(
          'SELECT userId,mountId,path FROM auth_homes ORDER BY mountId,path',
        )
        .all(),
      memberships: this.db
        .query(
          'SELECT userId,groupId FROM auth_members ORDER BY userId,groupId',
        )
        .all(),
      grants: this.db
        .query(
          'SELECT subjectType,subjectId,mountId,path,permission,effect FROM auth_grants ORDER BY mountId,path,subjectId,permission',
        )
        .all(),
      sessions: this.db
        .query(
          `SELECT ${sessionFields} FROM auth_sessions WHERE userId IS NOT NULL ORDER BY lastSeen DESC LIMIT 500`,
        )
        .all(this.contextsByUser.get(actor) ?? null),
      tokens: this.db
        .query(
          'SELECT id,userId,label,scope,expiresAt FROM auth_tokens ORDER BY expiresAt DESC LIMIT 500',
        )
        .all(),
      audit: this.db
        .query(
          'SELECT at,actor,event FROM auth_audit ORDER BY id DESC LIMIT 150',
        )
        .all(),
    }
  }

  userData(user: User) {
    this.requireLive(user)
    this.storage.sweep()
    return {
      groups: this.db
        .query(
          'SELECT g.id,g.name FROM auth_groups g JOIN auth_members m ON m.groupId=g.id WHERE m.userId=? ORDER BY g.name',
        )
        .all(user.id),
      sessions: this.db
        .query(
          `SELECT ${sessionFields} FROM auth_sessions WHERE userId=? ORDER BY lastSeen DESC`,
        )
        .all(this.contextsByUser.get(user) ?? null, user.id),
      tokens: this.db
        .query(
          'SELECT id,userId,label,scope,expiresAt FROM auth_tokens WHERE userId=? ORDER BY expiresAt DESC',
        )
        .all(user.id),
    }
  }

  private revokeUserSessions(id: string) {
    this.db.query('DELETE FROM auth_sessions WHERE userId=?').run(id)
  }

  private revokeCredentials(id: string) {
    this.revokeUserSessions(id)
    this.db.query('DELETE FROM auth_tokens WHERE userId=?').run(id)
  }

  private findAccount(fields: Fields) {
    const row = this.db
      .query<Account, [string]>(
        'SELECT id,username,passwordHash,enabled,admin FROM auth_users WHERE id=?',
      )
      .get(text(fields, 'userId'))
    if (!row) throw new AppError(404, 'Account does not exist.')
    return row
  }

  private ensureAnotherAdmin(account: Account) {
    if (
      account.admin &&
      account.enabled &&
      !this.db
        .query(
          'SELECT 1 FROM auth_users WHERE admin=1 AND enabled=1 AND id<>? LIMIT 1',
        )
        .get(account.id)
    ) {
      throw new AppError(409, 'Keep at least one enabled administrator.')
    }
  }

  private updateGrant(fields: Fields) {
    const subjectType = text(fields, 'subjectType')
    const subjectId = text(fields, 'subjectId')
    const mountId = text(fields, 'mountId')
    const permission = text(fields, 'permission') as Action
    const effect = text(fields, 'effect')
    if (
      !['user', 'group'].includes(subjectType) ||
      !['allow', 'deny', 'remove'].includes(effect) ||
      !actions.includes(permission)
    )
      throw bad('Invalid permission rule.')
    if (!this.config.mounts.some((m) => m.id === mountId))
      throw bad('Unknown storage root.')
    const subject =
      subjectType === 'user'
        ? this.db.query('SELECT 1 FROM auth_users WHERE id=?').get(subjectId)
        : this.db.query('SELECT 1 FROM auth_groups WHERE id=?').get(subjectId)
    if (!subject) throw bad('Unknown permission subject.')
    const path = validatePath(fields.path)
    if (effect === 'remove') {
      this.db
        .query(
          'DELETE FROM auth_grants WHERE subjectType=? AND subjectId=? AND mountId=? AND path=? AND permission=?',
        )
        .run(subjectType, subjectId, mountId, path, permission)
    } else {
      this.db
        .query(
          `INSERT INTO auth_grants(subjectType,subjectId,mountId,path,permission,effect) VALUES (?,?,?,?,?,?)
        ON CONFLICT (subjectType,subjectId,mountId,path,permission) DO UPDATE SET effect=excluded.effect`,
        )
        .run(subjectType, subjectId, mountId, path, permission, effect)
    }
    if (subjectType === 'user') this.revokeUserSessions(subjectId)
    else
      this.db
        .query(
          'DELETE FROM auth_sessions WHERE userId IN (SELECT userId FROM auth_members WHERE groupId=?)',
        )
        .run(subjectId)
  }

  private passwordEffect<T>(work: () => Promise<T>) {
    const guarded = this.hashSlots.withPermitsIfAvailable(1)(
      Effect.uninterruptible(attempt(work)),
    )
    return Effect.flatMap(guarded, (result) =>
      Option.isSome(result)
        ? Effect.succeed(result.value)
        : Effect.fail(new AppError(429, 'Password verification is busy.')),
    )
  }

  manage(actor: User, fields: Fields): Promise<void> {
    return runTask(this.manageEffect(actor, fields))
  }

  manageEffect(actor: User, fields: Fields) {
    return Effect.gen({ self: this }, function* () {
      const action = yield* Effect.try({
        try: () => {
          this.requireLive(actor, true)
          return text(fields, 'action')
        },
        catch: asAppError,
      })
      let passwordHash: string | undefined
      if (action === 'createUser' || action === 'resetPassword') {
        const password = fields.password
        if (!validPassword(password))
          return yield* Effect.fail(bad('Use a password of 12–1024 bytes.'))
        passwordHash = yield* this.passwordEffect(() =>
          Bun.password.hash(password, hashOptions),
        )
      }
      yield* Effect.try({
        try: () => this.applyAdminChange(actor, fields, action, passwordHash),
        catch: asAppError,
      })
    })
  }

  private applyAdminChange(
    actor: User,
    fields: Fields,
    action: string,
    passwordHash?: string,
  ) {
    this.db
      .transaction(() => {
        this.requireLive(actor, true)
        switch (action) {
          case 'createUser': {
            const username = text(fields, 'username')
            if (!namePattern.test(username)) throw bad('Invalid username.')
            if (
              this.db
                .query('SELECT 1 FROM auth_users WHERE username=?')
                .get(username)
            )
              throw new AppError(409, 'Username already exists.')
            this.db
              .query(
                'INSERT INTO auth_users(id,username,passwordHash,admin) VALUES (?,?,?,?)',
              )
              .run(
                randomUUID(),
                username,
                passwordHash ?? missingHash(),
                Number(booleanValue(fields.admin)),
              )
            break
          }
          case 'createGroup': {
            const name = text(fields, 'name', 96).trim()
            if (!name || /[\x00-\x1f]/.test(name))
              throw bad('Invalid group name.')
            if (
              this.db.query('SELECT 1 FROM auth_groups WHERE name=?').get(name)
            )
              throw new AppError(409, 'Group already exists.')
            this.db
              .query('INSERT INTO auth_groups(id,name) VALUES (?,?)')
              .run(randomUUID(), name)
            break
          }
          case 'setEnabled':
          case 'setAdmin': {
            const account = this.findAccount(fields)
            const enabled = booleanValue(
              fields[action === 'setEnabled' ? 'enabled' : 'admin'],
            )
            if (!enabled) this.ensureAnotherAdmin(account)
            if (action === 'setEnabled')
              this.db
                .query('UPDATE auth_users SET enabled=? WHERE id=?')
                .run(Number(enabled), account.id)
            else
              this.db
                .query('UPDATE auth_users SET admin=? WHERE id=?')
                .run(Number(enabled), account.id)
            this.revokeCredentials(account.id)
            break
          }
          case 'resetPassword': {
            const account = this.findAccount(fields)
            this.db
              .query('UPDATE auth_users SET passwordHash=? WHERE id=?')
              .run(passwordHash ?? missingHash(), account.id)
            this.revokeCredentials(account.id)
            break
          }
          case 'setMembership': {
            const { id } = this.findAccount(fields)
            const groupId = text(fields, 'groupId')
            if (
              !this.db
                .query('SELECT 1 FROM auth_groups WHERE id=?')
                .get(groupId)
            )
              throw bad('Unknown group.')
            if (booleanValue(fields.member))
              this.db
                .query(
                  'INSERT OR IGNORE INTO auth_members(userId,groupId) VALUES (?,?)',
                )
                .run(id, groupId)
            else
              this.db
                .query('DELETE FROM auth_members WHERE userId=? AND groupId=?')
                .run(id, groupId)
            this.revokeUserSessions(id)
            break
          }
          case 'setBandwidth': {
            const { id } = this.findAccount(fields)
            const input = fields.bytesPerSecond
            if (
              input === '' ||
              input === null ||
              input === 0 ||
              input === '0'
            ) {
              this.db
                .query('DELETE FROM auth_user_bandwidth WHERE userId=?')
                .run(id)
            } else {
              if (
                (typeof input !== 'number' && typeof input !== 'string') ||
                !/^[1-9]\d*$/.test(String(input)) ||
                !Number.isSafeInteger(Number(input))
              )
                throw bad(
                  'Enter a positive whole number of bytes per second, or leave it blank for unlimited.',
                )
              this.db
                .query(
                  'INSERT INTO auth_user_bandwidth(userId,rate) VALUES(?,?) ON CONFLICT(userId) DO UPDATE SET rate=excluded.rate',
                )
                .run(id, Number(input))
            }
            break
          }
          case 'setQuota': {
            const { id } = this.findAccount(fields)
            const rawBytes = fields.bytes
            if (
              rawBytes != null &&
              typeof rawBytes !== 'string' &&
              typeof rawBytes !== 'number'
            )
              throw bad('Quota must be a number of bytes.')
            const bytes =
              rawBytes == null || rawBytes === '' ? null : Number(rawBytes)
            if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0))
              throw bad('Quota must be a non-negative number of bytes.')
            this.db
              .query('UPDATE auth_users SET quota=? WHERE id=?')
              .run(bytes, id)
            break
          }
          case 'setHome': {
            const { id } = this.findAccount(fields)
            const mountId = text(fields, 'mountId')
            const path = validatePath(fields.path)
            if (!path || !this.config.mounts.some((m) => m.id === mountId))
              throw bad('Select a directory within a configured mount.')
            const conflict = this.db
              .query(
                `SELECT 1 FROM auth_homes WHERE mountId=? AND userId<>?
              AND (path=? OR substr(path,1,length(?)+1)=?||'/' OR substr(?,1,length(path)+1)=path||'/')`,
              )
              .get(mountId, id, path, path, path, path)
            if (conflict)
              throw new AppError(409, 'Home directories cannot overlap.')
            this.db
              .query(
                `INSERT INTO auth_homes(userId,mountId,path) VALUES(?,?,?)
              ON CONFLICT(userId) DO UPDATE SET mountId=excluded.mountId,path=excluded.path`,
              )
              .run(id, mountId, path)
            this.revokeUserSessions(id)
            break
          }
          case 'setGrant':
            this.updateGrant(fields)
            break
          case 'revokeSession':
            this.db
              .query('DELETE FROM auth_sessions WHERE publicId=?')
              .run(text(fields, 'id'))
            break
          case 'revokeToken':
            this.db
              .query('DELETE FROM auth_tokens WHERE id=?')
              .run(text(fields, 'id'))
            break
          default:
            throw bad('Unknown administrative action.')
        }
        this.audit(actor.id, action)
      })
      .immediate()
    if (action === 'setBandwidth') {
      const userId = text(fields, 'userId')
      const rate = Number(fields.bytesPerSecond)
      if (rate) this.bandwidthLimits.set(userId, rate)
      else this.bandwidthLimits.delete(userId)
    }
  }

  async self(user: User, fields: Fields): Promise<{ token?: string }> {
    this.requireLive(user)
    const action = text(fields, 'action')
    switch (action) {
      case 'changePassword': {
        if (!validPassword(fields.password))
          throw bad('Use a password of 12–1024 bytes.')
        const previous = text(fields, 'currentPassword', 1024)
        const password = fields.password
        const row = this.db
          .query<{ passwordHash: string }, [string]>(
            'SELECT passwordHash FROM auth_users WHERE id=? AND enabled=1',
          )
          .get(user.id)
        if (!row) throw forbidden()
        this.consumePasswordAttempt('change:' + user.id)
        const hash = await this.passwordWork(async () => {
          if (!(await Bun.password.verify(previous, row.passwordHash)))
            throw new AppError(401, 'Invalid current password.')
          return Bun.password.hash(password, hashOptions)
        })
        this.db.transaction(() => {
          this.requireLive(user)
          const updated = this.db
            .query(
              'UPDATE auth_users SET passwordHash=? WHERE id=? AND passwordHash=? AND enabled=1',
            )
            .run(hash, user.id, row.passwordHash)
          if (!updated.changes) throw forbidden()
          this.revokeCredentials(user.id)
          this.audit(user.id, action)
        })()
        return {}
      }
      case 'issueToken': {
        const label = text(fields, 'label', 100).trim()
        const scope = [
          ...new Set(
            text(fields, 'scope')
              .split(',')
              .map((s) => s.trim()),
          ),
        ]
        const days = Number(fields.days ?? 30)
        if (
          !label ||
          !scope.every((a) => a === 'read' || a === 'list') ||
          !Number.isInteger(days) ||
          days < 1 ||
          days > 365
        )
          throw bad('Invalid token label, read/list scope, or expiry.')
        const token = 'fs_' + randomBytes(32).toString('base64url')
        this.storage.sweep()
        this.db.transaction(() => {
          const used = this.db
            .query<{ n: number }, [string]>(
              'SELECT count(*) AS n FROM auth_tokens WHERE userId=?',
            )
            .get(user.id)
          if ((used?.n ?? 0) >= 32)
            throw new AppError(
              409,
              'Revoke an existing token before issuing another.',
            )
          this.db
            .query(
              'INSERT INTO auth_tokens(id,digest,userId,label,scope,expiresAt) VALUES (?,?,?,?,?,?)',
            )
            .run(
              randomUUID(),
              digest(token),
              user.id,
              label,
              scope.join(','),
              this.clock.currentTimeMillisUnsafe() + days * 86400000,
            )
          this.audit(user.id, action)
        })()
        return { token }
      }
      case 'revokeToken':
        this.db
          .query('DELETE FROM auth_tokens WHERE id=? AND userId=?')
          .run(text(fields, 'id'), user.id)
        break
      case 'revokeSession':
        this.db
          .query('DELETE FROM auth_sessions WHERE publicId=? AND userId=?')
          .run(text(fields, 'id'), user.id)
        break
      default:
        throw bad('Unknown account action.')
    }
    this.audit(user.id, action)
    return {}
  }
}
