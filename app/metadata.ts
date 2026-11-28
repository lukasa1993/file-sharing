import type { Database } from 'bun:sqlite'
import type { SqliteDatabase } from 'remix/data-table/sqlite'
import { array, object, parseSafe, string } from 'remix/data-schema'
import { AppError, type Guard, type ResourceRef } from './contracts.ts'

const refSchema = object({ mountId: string(), segments: array(string()) })
export function resource(value: unknown): ResourceRef {
  const result = parseSafe(refSchema, value)
  if (!result.success)
    throw new AppError(400, 'Choose a valid storage location')
  const ref = result.value
  if (
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(ref.mountId) ||
    ref.segments.length > 128 ||
    ref.segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        /[\\/\x00]/.test(segment) ||
        Buffer.byteLength(segment) > 255,
    )
  ) {
    throw new AppError(400, 'Invalid storage location')
  }
  return ref
}
export function selected(value: unknown): ResourceRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256)
    throw new AppError(400, 'Select between 1 and 256 items')
  return value.map(resource)
}
export function requestRef(url: URL): ResourceRef {
  const path = url.searchParams.get('path') || ''
  return resource({
    mountId: url.searchParams.get('mount'),
    segments: path ? path.split('/') : [],
  })
}
export async function initializeMetadata(db: SqliteDatabase) {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS app_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  )
  await db.exec(
    'CREATE TABLE IF NOT EXISTS app_settings(name TEXT PRIMARY KEY, value TEXT NOT NULL)',
  )
  await db.exec(
    'CREATE TABLE IF NOT EXISTS bookmarks(user_id TEXT NOT NULL, category TEXT NOT NULL, ref TEXT NOT NULL, touched INTEGER NOT NULL, PRIMARY KEY(user_id,category,ref))',
  )
  await db.exec(
    'CREATE TABLE IF NOT EXISTS user_preferences(user_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(user_id,name))',
  )
  await db.exec(
    'CREATE TABLE IF NOT EXISTS operation_log(id INTEGER PRIMARY KEY, request_id TEXT NOT NULL, actor_id TEXT, operation TEXT NOT NULL, status INTEGER NOT NULL, duration_ms INTEGER NOT NULL, recorded_at INTEGER NOT NULL)',
  )
  await db.exec(
    'INSERT OR IGNORE INTO app_migrations(version,applied_at) VALUES(1,CURRENT_TIMESTAMP)',
  )
}
export class Metadata {
  constructor(private db: Database) {}
  value(key: string, fallback: string) {
    return (
      this.db
        .query<{ value: string }, [string]>(
          'SELECT value FROM app_settings WHERE name=?',
        )
        .get(key)?.value ?? fallback
    )
  }
  set(key: string, value: string) {
    this.db
      .query('INSERT OR REPLACE INTO app_settings(name,value) VALUES(?,?)')
      .run(key, value)
  }
  log(
    id: string,
    actor: string | null,
    operation: string,
    status: number,
    duration: number,
  ) {
    this.db
      .query(
        'INSERT INTO operation_log(request_id,actor_id,operation,status,duration_ms,recorded_at) VALUES(?,?,?,?,?,?)',
      )
      .run(id, actor, operation, status, duration, Date.now())
  }
  trimLog() {
    this.db.run(
      'DELETE FROM operation_log WHERE id <= (SELECT MAX(id)-10000 FROM operation_log)',
    )
  }
  activity() {
    return this.db
      .query<
        {
          request_id: string
          actor_id: string | null
          operation: string
          status: number
          duration_ms: number
          recorded_at: number
        },
        []
      >(
        'SELECT request_id,actor_id,operation,status,duration_ms,recorded_at FROM operation_log ORDER BY id DESC LIMIT 100',
      )
      .all()
  }
  bookmark(user: string, category: 'favorites' | 'recents', ref: ResourceRef) {
    const encoded = JSON.stringify(ref)
    this.db.transaction(() => {
      this.db
        .query(
          'INSERT OR REPLACE INTO bookmarks(user_id,category,ref,touched) VALUES(?,?,?,?)',
        )
        .run(user, category, encoded, Date.now())
      this.db
        .query(
          'DELETE FROM bookmarks WHERE user_id=? AND category=? AND ref IN (SELECT ref FROM bookmarks WHERE user_id=? AND category=? ORDER BY touched DESC, rowid DESC LIMIT -1 OFFSET 100)',
        )
        .run(user, category, user, category)
    })()
  }
  displayPreferences(user: string) {
    const rows = this.db
      .query<{ name: string; value: string }, [string]>(
        'SELECT name,value FROM user_preferences WHERE user_id=?',
      )
      .all(user)
    const settings = Object.fromEntries(
      rows.map((row) => [row.name, row.value]),
    )
    return {
      sort: settings.sort ?? 'name',
      theme: settings.theme ?? 'system',
      view: settings.view ?? 'list',
    }
  }
  preferences(user: string, guard: Guard) {
    const rows = this.db
      .query<{ category: string; ref: string }, [string]>(
        'SELECT category,ref FROM bookmarks WHERE user_id=? ORDER BY touched DESC, rowid DESC',
      )
      .all(user)
    const favorites: ResourceRef[] = [],
      recents: ResourceRef[] = []
    for (const row of rows) {
      const ref = resource(JSON.parse(row.ref))
      try {
        guard('list', ref)
      } catch (e) {
        if (e instanceof AppError && (e.status === 403 || e.status === 404))
          continue
        throw e
      }
      ;(row.category === 'favorites' ? favorites : recents).push(ref)
    }
    return {
      ...this.displayPreferences(user),
      favorites,
      recents,
    }
  }
  updatePreferences(user: string, data: Record<string, unknown>, guard: Guard) {
    const allowed: Record<string, readonly string[]> = {
      view: ['list', 'grid'],
      theme: ['system', 'light', 'dark'],
      sort: [
        'name',
        'type',
        'size',
        'mtime',
        'modifiedAt',
        'name-desc',
        'size-desc',
        'mtime-desc',
        'type-desc',
      ],
    }
    this.db.transaction(() => {
      for (const [key, choices] of Object.entries(allowed)) {
        const value = data[key]
        if (value === undefined) continue
        if (typeof value !== 'string' || !choices.includes(value))
          throw new AppError(400, 'Invalid preference')
        this.db
          .query(
            'INSERT OR REPLACE INTO user_preferences(user_id,name,value) VALUES(?,?,?)',
          )
          .run(user, key, value)
      }
      if (data.favorite) {
        const ref = resource(data.favorite)
        guard('list', ref)
        this.bookmark(user, 'favorites', ref)
      }
      if (data.removeFavorite)
        this.db
          .query(
            "DELETE FROM bookmarks WHERE user_id=? AND category='favorites' AND ref=?",
          )
          .run(user, JSON.stringify(resource(data.removeFavorite)))
    })()
    return this.preferences(user, guard)
  }
}
