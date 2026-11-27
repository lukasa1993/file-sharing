import type { Database } from 'bun:sqlite'
import { Clock, Effect } from 'effect'
import { attempt, runTask } from '../effects.ts'
import { AppError, defaultBrand, type Entry, type User } from '../contracts'
import type { Transfers } from '../transfers'
import { renderPublicShare } from '../ui'
import {
  keyForSession,
  ShareStore,
  validateSegment,
  type Share,
  type ShareSession,
  type ShareIdentity,
  type ShareFilesystem,
} from './store'

export type { ShareDto, ShareInput, ShareSession } from './store'

const unavailable = () => new AppError(404, 'Share unavailable.')
const href = (parts: string[]) => '/' + parts.map(encodeURIComponent).join('/')

async function readBody(request: Request, max = 128_000): Promise<string> {
  const reader = request.body?.getReader()
  if (!reader) throw new AppError(400, 'Request body required.')
  const text = new TextDecoder('utf-8', { fatal: true })
  let size = 0,
    result = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return result + text.decode()
      size += value.byteLength
      if (size > max) {
        await reader.cancel()
        throw new AppError(413, 'Request too large.')
      }
      result += text.decode(value, { stream: true })
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(400, 'Invalid request body.')
  } finally {
    reader.releaseLock()
  }
}
function publicPath(request: Request) {
  let pathname = new URL(request.url).pathname
  if (pathname.endsWith('/')) pathname = pathname.slice(0, -1)
  const parts = pathname.slice(1).split('/')
  if (parts.length > 129) throw unavailable()
  return parts.map((part) => {
    let value: string
    try {
      value = decodeURIComponent(part)
    } catch {
      throw unavailable()
    }
    validateSegment(value)
    return value
  })
}
function method(allow: string) {
  return new Response(null, { status: 405, headers: { Allow: allow } })
}
function noHead(request: Request, response: Response) {
  if (request.method !== 'HEAD') return response
  return new Response(null, {
    status: response.status,
    headers: response.headers,
  })
}

export class Shares extends ShareStore {
  private attempts = new Map<string, { count: number; until: number }>()

  constructor(
    db: Database,
    fs: ShareFilesystem,
    identity: ShareIdentity,
    protected transfers: Pick<Transfers, 'download' | 'preview' | 'archive'>,
    clock?: Clock.Clock,
  ) {
    super(db, fs, identity, clock)
  }

  async owner(request: Request, user: User): Promise<Response> {
    if (request.headers.has('Authorization'))
      throw new AppError(403, 'Sign in to manage sharing links.')
    const path = new URL(request.url).pathname
    const match = /^\/_\/api\/v1\/shares(?:\/([^/]+))?\/?$/.exec(path)
    if (!match) throw unavailable()
    const id = match[1]
    if (request.method === 'GET') {
      if (!id) return Response.json(this.list(user))
      return Response.json(this.details(user, id))
    }
    if (request.method === 'DELETE' && id) {
      this.remove(user, id)
      return new Response(null, { status: 204 })
    }
    if (
      ((!id || id === 'batch') && request.method === 'POST') ||
      (id && request.method === 'PATCH')
    ) {
      if (
        request.headers.get('Content-Type')?.split(';')[0]?.trim() !==
        'application/json'
      )
        throw new AppError(415, 'Use application/json.')
      const body = await readBody(request)
      let input: unknown
      try {
        input = JSON.parse(body)
      } catch {
        throw new AppError(400, 'Invalid JSON.')
      }
      if (id === 'batch') {
        this.batch(user, input)
        return new Response(null, { status: 204 })
      }
      return Response.json(await this.save(user, input, id), {
        status: id ? 200 : 201,
      })
    }
    return method(id ? 'GET, PATCH, DELETE' : 'GET, POST')
  }

  private async unlock(
    request: Request,
    id: string,
    access: ShareSession,
    brand: string,
    peer?: string,
  ) {
    if (request.method !== 'POST') return method('POST')
    const s = this.byId(id)
    this.requireActive(s)
    if (
      s.access !== 'password' ||
      !s.passwordHash ||
      !access.sessionId ||
      !this.identity.sessionActive(access.sessionId)
    )
      throw unavailable()
    const recipient = keyForSession(access.sessionId)
    const form = new URLSearchParams(await readBody(request, 4096))
    const base = '/' + s.alias
    const candidate = form.get('returnTo') ?? base
    let location = base
    if (candidate.startsWith('/') && URL.canParse(candidate, request.url)) {
      const dest = new URL(candidate, request.url)
      if (
        dest.origin === new URL(request.url).origin &&
        (dest.pathname === base || dest.pathname.startsWith(base + '/'))
      )
        location = dest.pathname + dest.search
    }
    const password = form.get('password')
    if (!password || Buffer.byteLength(password) > 512)
      throw new AppError(400, 'Enter the share password.')
    const now = this.clock.currentTimeMillisUnsafe()
    for (const [key, record] of this.attempts)
      if (record.until <= now) this.attempts.delete(key)
    const recipientKey = s.id + ':' + recipient
    const buckets = [
      { key: s.id, limit: 40 },
      { key: recipientKey, limit: 8 },
    ]
    if (
      buckets.some(
        ({ key, limit }) => (this.attempts.get(key)?.count ?? 0) >= limit,
      )
    )
      throw new AppError(429, 'Too many attempts. Try again later.')
    this.identity.consumePasswordAttempt('share:' + recipientKey, peer)
    for (const { key } of buckets) {
      const record = this.attempts.get(key) ?? { count: 0, until: now + 60_000 }
      record.count++
      this.attempts.set(key, record)
    }
    const hash = s.passwordHash
    const accepted = await runTask(
      this.passwordWork(() => Bun.password.verify(password, hash)),
    )
    if (!accepted)
      return renderPublicShare({
        kind: 'unlock',
        title: 'Password required',
        alias: s.alias,
        id: s.id,
        csrf: access.csrf,
        unlockUrl: '/_/shares/' + s.id + '/unlock',
        returnTo: location,
        brand,
        error: 'Incorrect password.',
        status: 403,
      })
    const active = this.byId(id)
    this.requireActive(active)
    if (
      active.revision !== s.revision ||
      !this.identity.sessionActive(access.sessionId)
    )
      throw unavailable()
    this.db
      .query('DELETE FROM share_grants WHERE expires<=?')
      .run(this.clock.currentTimeMillisUnsafe())
    this.db
      .query('INSERT OR REPLACE INTO share_grants VALUES(?,?,?,?)')
      .run(
        s.id,
        s.revision,
        recipient,
        Math.min(
          now + 3600_000,
          s.expiresAt ? Date.parse(s.expiresAt) : Infinity,
        ),
      )
    return new Response(null, { status: 303, headers: { Location: location } })
  }

  async uploadAccess(alias: string, access: ShareSession) {
    const s = this.byAlias(alias)
    this.authorize(s, access)
    if (
      s.kind !== 'upload' ||
      !access.sessionId ||
      !this.identity.sessionActive(access.sessionId)
    )
      throw unavailable()
    const guard = this.scopedGuard(s, access)
    const target = s.targets[0]
    if (!target) throw unavailable()
    await this.targetEntry(s, target, guard)
    const session = access.sessionId
    return {
      actor: `share:${s.id}:${s.revision}:${keyForSession(session)}`,
      scope: 'share:' + s.id,
      bandwidthBudgets: this.bandwidthBudgets(s, access),
      base: target.ref,
      guard,
      ...(s.maxBytes === null ? {} : { cap: s.maxBytes }),
      location: '/_/uploads?share=' + encodeURIComponent(alias),
      revalidate: () => {
        if (!this.identity.sessionActive(session)) throw unavailable()
        guard('upload', target.ref)
      },
    }
  }
  private bandwidthBudgets(s: Share, access: ShareSession) {
    return [
      { key: 'share:' + s.id, rate: s.bytesPerSecond ?? 0 },
      ...(access.user ? [this.identity.bandwidthBudget(access.user.id)] : []),
    ]
  }
  private transferOptions(s: Share, access: ShareSession, resource: string) {
    return {
      actor: 'share:' + s.id,
      bandwidthBudgets: this.bandwidthBudgets(s, access),
      onStart: (version: string) =>
        this.recordStart(
          s,
          access,
          keyForSession(JSON.stringify([resource, version])),
        ),
      onBytes: (amount: number) => {
        this.db
          .query('UPDATE shares SET bytesServed=bytesServed+? WHERE id=?')
          .run(amount, s.id)
      },
      validateEntry: (entry: Entry) => this.validateEntry(s, entry),
    }
  }

  async public(
    request: Request,
    access: ShareSession,
    brand = defaultBrand,
    peer?: string,
  ): Promise<Response> {
    const url = new URL(request.url)
    const unlock = /^\/_\/shares\/([^/]+)\/unlock$/.exec(url.pathname)
    if (unlock?.[1]) return this.unlock(request, unlock[1], access, brand, peer)
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return method('GET, HEAD')
    const parts = publicPath(request)
    const [alias, ...subpath] = parts
    if (!alias) throw unavailable()
    const s = this.byAlias(alias)
    this.requireActive(s)
    const common = { alias, id: s.id, csrf: access.csrf, brand }
    try {
      this.authorize(s, access)
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 401) throw error
      if (s.access === 'authenticated')
        return new Response(null, {
          status: 303,
          headers: {
            Location:
              '/login?next=' + encodeURIComponent(url.pathname + url.search),
          },
        })
      return noHead(
        request,
        await renderPublicShare({
          ...common,
          kind: 'unlock',
          title: 'Password required',
          unlockUrl: '/_/shares/' + s.id + '/unlock',
          returnTo: url.pathname + url.search,
          status: 401,
        }),
      )
    }
    const guard = this.scopedGuard(s, access)
    const options = this.transferOptions(s, access, href(parts))
    if (s.kind === 'upload') {
      if (subpath.length) throw unavailable()
      const folder = s.targets[0]
      if (!folder) throw unavailable()
      await this.targetEntry(s, folder, guard)
      return noHead(
        request,
        await renderPublicShare({
          ...common,
          kind: 'upload',
          title: 'Send files',
          uploadUrl: '/_/uploads?share=' + alias,
        }),
      )
    }
    const selection = s.targets.length > 1
    const archive = url.searchParams.get('archive') === '1'
    if (selection && !subpath.length) {
      const entries = await runTask(
        Effect.forEach(
          s.targets,
          (t) => attempt(() => this.targetEntry(s, t, guard)),
          { concurrency: 4 },
        ),
        { signal: request.signal },
      )
      if (archive)
        return this.transfers.archive(
          request,
          s.targets.map((t) => t.ref),
          guard,
          options,
        )
      return noHead(
        request,
        await renderPublicShare({
          ...common,
          kind: 'selection',
          title: 'Shared files',
          entries: entries.map((entry, i) => ({
            name: entry.name,
            kind: entry.kind,
            size: entry.size,
            href: href([alias, '~' + i]),
          })),
          downloadUrl: href(parts) + '?archive=1',
        }),
      )
    }
    let chosen = 0,
      descendants = subpath
    if (selection) {
      const index = /^~(0|[1-9][0-9]?)$/.exec(subpath[0] ?? '')
      if (!index || Number(index[1]) >= s.targets.length) throw unavailable()
      chosen = Number(index[1])
      descendants = subpath.slice(1)
    }
    const target = s.targets[chosen]
    if (!target) throw unavailable()
    let entry = await this.targetEntry(s, target, guard)
    if (descendants.length) {
      if (target.kind !== 'directory') throw unavailable()
      const ref = {
        mountId: target.ref.mountId,
        segments: [...target.ref.segments, ...descendants],
      }
      // Read and listing grants are independent. Check the action for the resolved type again below.
      const owner = this.identity.getUser(s.ownerId)
      if (!owner) throw unavailable()
      entry = await this.fs.stat(
        ref,
        guard,
        this.identity.allowed(owner, 'read', ref) ? 'read' : 'list',
      )
    }
    guard(entry.kind === 'directory' ? 'list' : 'read', entry.ref)
    if (entry.kind === 'directory') {
      if (archive)
        return this.transfers.archive(request, [entry.ref], guard, options)
      const children = await this.fs.list(entry.ref, guard)
      const entries = children.map((child) => ({
        name: child.name,
        size: child.size,
        kind: child.kind,
        href: href([...parts, child.name]),
      }))
      return noHead(
        request,
        await renderPublicShare({
          ...common,
          kind: 'directory',
          title: entry.name || 'Shared folder',
          entries,
          ...(parts.length > 1 ? { parentUrl: href(parts.slice(0, -1)) } : {}),
          downloadUrl: href(parts) + '?archive=1',
        }),
      )
    }
    if (archive) throw unavailable()
    if (url.searchParams.get('preview') === '1') {
      // A preview may deliver the entire file and follows the same transfer budget.
      return this.transfers.preview(request, entry.ref, guard, options)
    }
    if (
      s.mode === 'landing' &&
      !descendants.length &&
      !selection &&
      url.searchParams.get('download') !== '1'
    )
      return noHead(
        request,
        await renderPublicShare({
          ...common,
          kind: 'file',
          title: entry.name,
          size: entry.size,
          downloadUrl: href(parts) + '?download=1',
        }),
      )
    return this.transfers.download(request, entry.ref, guard, options)
  }
}
