import type { Clock } from 'effect'
import type { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { Session, createSession, type SessionStorage } from 'remix/session'
import { AppError } from '../contracts.ts'

export const absoluteAge = 24 * 60 * 60 * 1000
const idleAge = 2 * 60 * 60 * 1000
const anonymousAge = 20 * 60 * 1000
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')

interface Row {
  data: string
  revision: number
  createdAt: number
  lastSeen: number
  userId: string | null
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function storedFields(
  row: Row,
): [Record<string, unknown>, Record<string, unknown>] {
  const invalid = (cause?: unknown) =>
    new AppError(503, 'Session storage is unavailable.', { cause })
  let data: unknown
  try {
    data = JSON.parse(row.data)
  } catch (cause) {
    throw invalid(cause)
  }
  if (
    !Array.isArray(data) ||
    data.length !== 2 ||
    !record(data[0]) ||
    !record(data[1])
  )
    throw invalid()
  if ((data[0].userId ?? null) !== row.userId) throw invalid()
  return [data[0], data[1]]
}

export class SqliteSessions implements SessionStorage {
  private origins = new WeakMap<Session, { key: string; revision: number }>()
  private sweptAt = -Infinity
  constructor(
    private db: Database,
    private clock: Clock.Clock,
  ) {}

  sweep(now = this.clock.currentTimeMillisUnsafe()) {
    if (now - this.sweptAt < 60_000) return
    this.sweptAt = now
    this.db
      .query(
        'DELETE FROM auth_sessions WHERE createdAt <= ? OR lastSeen <= ? OR (userId IS NULL AND createdAt <= ?)',
      )
      .run(now - absoluteAge, now - idleAge, now - anonymousAge)
    this.db.query('DELETE FROM auth_tokens WHERE expiresAt <= ?').run(now)
  }

  async read(value: string | null): Promise<Session> {
    const now = this.clock.currentTimeMillisUnsafe()
    this.sweep(now)
    if (!value) return createSession()
    const key = digest(value)
    const row = this.db
      .query<Row, [string]>(
        'SELECT data,revision,createdAt,lastSeen,userId FROM auth_sessions WHERE id=?',
      )
      .get(key)
    if (!row) return createSession()
    if (
      row.createdAt + (row.userId ? absoluteAge : anonymousAge) <= now ||
      row.lastSeen + idleAge <= now
    ) {
      this.db.query('DELETE FROM auth_sessions WHERE id=?').run(key)
      return createSession()
    }
    if (row.lastSeen < now - 60_000)
      this.db
        .query('UPDATE auth_sessions SET lastSeen=? WHERE id=?')
        .run(now, key)
    const session = createSession(value, storedFields(row))
    this.origins.set(session, { key, revision: row.revision })
    return session
  }

  key(session: Session): string | null {
    return this.origins.get(session)?.key ?? null
  }

  active(key: string): boolean {
    const now = this.clock.currentTimeMillisUnsafe()
    return Boolean(
      this.db
        .query(
          `SELECT 1 FROM auth_sessions s LEFT JOIN auth_users u ON u.id=s.userId
      WHERE s.id=? AND s.lastSeen>? AND s.createdAt>? AND ((s.userId IS NULL AND s.createdAt>?) OR u.enabled=1)`,
        )
        .get(key, now - idleAge, now - absoluteAge, now - anonymousAge),
    )
  }

  async save(session: Session): Promise<string | null> {
    const key = digest(session.id)
    const origin = this.origins.get(session)
    const now = this.clock.currentTimeMillisUnsafe()
    if (session.destroyed) {
      if (origin)
        this.db.query('DELETE FROM auth_sessions WHERE id=?').run(origin.key)
      return ''
    }
    if (!session.dirty) return null
    const userId = session.get('userId')
    if (userId != null && typeof userId !== 'string')
      throw new Error('Invalid session owner')
    const data = JSON.stringify(session.data)
    this.db.transaction(() => {
      if (origin?.key === key) {
        const updated = this.db
          .query(
            'UPDATE auth_sessions SET data=?,userId=?,revision=revision+1 WHERE id=? AND revision=? AND lastSeen>? AND createdAt>? AND (userId IS NOT NULL OR createdAt>?)',
          )
          .run(
            data,
            userId ?? null,
            key,
            origin.revision,
            now - idleAge,
            now - absoluteAge,
            now - anonymousAge,
          )
        if (!updated.changes)
          throw new AppError(401, 'Session expired. Please sign in again.')
        return
      }
      if (origin) {
        const deleted = this.db
          .query(
            'DELETE FROM auth_sessions WHERE id=? AND revision=? AND lastSeen>? AND createdAt>? AND (userId IS NOT NULL OR createdAt>?)',
          )
          .run(
            origin.key,
            origin.revision,
            now - idleAge,
            now - absoluteAge,
            now - anonymousAge,
          )
        if (!deleted.changes)
          throw new AppError(401, 'Session expired. Please sign in again.')
      }
      if (
        !userId &&
        this.db
          .query(
            'SELECT 1 FROM auth_sessions WHERE userId IS NULL LIMIT 1 OFFSET 9999',
          )
          .get()
      ) {
        throw new AppError(
          429,
          'Too many active anonymous sessions. Try again later.',
        )
      }
      this.db
        .query(
          'INSERT INTO auth_sessions (id,publicId,userId,data,createdAt,lastSeen) VALUES (?,?,?,?,?,?)',
        )
        .run(key, randomUUID(), userId ?? null, data, now, now)
    })()
    this.origins.set(session, {
      key,
      revision: origin?.key === key ? origin.revision + 1 : 0,
    })
    return session.id
  }
}
