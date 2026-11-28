import type { DurableObjectStorage } from '@cloudflare/workers-types'
import { TransferError } from '../shared/transfers.ts'

export const cloudLimits = Object.freeze({
  maxFileBytes: 100_000_000,
  highWaterBytes: 3_600_000_000,
  capacityBytes: 4_000_000_000,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  pendingMs: 24 * 60 * 60 * 1000,
  claimMs: 5 * 60 * 1000,
})

export type CatalogStorage = Pick<
  DurableObjectStorage,
  'sql' | 'transactionSync'
>
export type CloudFileState =
  'reserved' | 'creating' | 'uploading' | 'completing' | 'ready' | 'deleting'
export type CloudFile = {
  id: string
  key: string
  ownerId: string
  creatorOwnerId: string
  requestId: string | null
  name: string
  size: number
  state: CloudFileState
  uploadId: string | null
  createdAt: number
  expiresAt: number
}
type Cleanup = 'none' | 'discover' | 'multipart' | 'object'
type FileRow = CloudFile & {
  idempotencyKey: string | null
  claimToken: string | null
  leaseUntil: number
  cleanup: Cleanup | null
  doneToken: string | null
}
export type UploadClaim = {
  file: CloudFile
  token: string | null
  reconcileFirst: boolean
}
export type CleanupClaim = { file: CloudFile; token: string; cleanup: Cleanup }
export type CapacityAlert = {
  id: string
  bytes: number
  createdAt: number
  attempts: number
  token: string
}
type InputScope = { ownerId: string; requestId: string }

const fail = (status: number, message: string): never => {
  throw new TransferError(status, message)
}
function identity(value: string, label: string) {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 256 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail(400, 'Invalid ' + label)
}
function nowValue(now: number) {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - cloudLimits.retentionMs
  )
    fail(400, 'Invalid timestamp')
}
function batchLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    fail(400, 'Invalid batch size')
}
function file(row: FileRow): CloudFile {
  return {
    id: row.id,
    key: row.key,
    ownerId: row.ownerId,
    creatorOwnerId: row.creatorOwnerId,
    requestId: row.requestId,
    name: row.name,
    size: row.size,
    state: row.state,
    uploadId: row.uploadId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }
}

// All transitions here are synchronous SQLite transactions in one Durable Object.
// The Worker performs R2 calls outside these transactions and returns their claim tokens.
export class CloudCatalog {
  constructor(private readonly storage: CatalogStorage) {
    storage.transactionSync(() => {
      const sql = storage.sql
      sql.exec(`CREATE TABLE IF NOT EXISTS cloud_files(
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, ownerId TEXT NOT NULL, creatorOwnerId TEXT NOT NULL,
        requestId TEXT, name TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0 AND size <= 100000000),
        state TEXT NOT NULL CHECK(state IN ('reserved','creating','uploading','completing','ready','deleting')),
        uploadId TEXT, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
        claimToken TEXT, leaseUntil INTEGER NOT NULL DEFAULT 0, doneToken TEXT, cleanup TEXT,
        idempotencyKey TEXT, UNIQUE(creatorOwnerId, idempotencyKey))`)
      sql.exec(
        'CREATE INDEX IF NOT EXISTS cloud_owner_listing ON cloud_files(ownerId, state, createdAt DESC, id DESC)',
      )
      sql.exec(
        'CREATE INDEX IF NOT EXISTS cloud_expiration ON cloud_files(expiresAt, id)',
      )
      sql.exec(
        'CREATE INDEX IF NOT EXISTS cloud_cleanup ON cloud_files(state, leaseUntil, expiresAt)',
      )
      sql.exec(
        'CREATE TABLE IF NOT EXISTS cloud_capacity(id INTEGER PRIMARY KEY CHECK(id=1), used INTEGER NOT NULL CHECK(used >= 0 AND used <= 4000000000))',
      )
      sql.exec('INSERT OR IGNORE INTO cloud_capacity VALUES (1,0)')
      sql.exec(`CREATE TABLE IF NOT EXISTS cloud_retired_requests(
        creatorOwnerId TEXT NOT NULL, requestKey TEXT NOT NULL, expiresAt INTEGER NOT NULL,
        PRIMARY KEY(creatorOwnerId,requestKey))`)
      sql.exec(
        'CREATE INDEX IF NOT EXISTS cloud_retired_expiry ON cloud_retired_requests(expiresAt)',
      )
      sql.exec(`CREATE TABLE IF NOT EXISTS cloud_capacity_alerts(
        id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, createdAt INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, token TEXT, availableAt INTEGER NOT NULL DEFAULT 0)`)
    })
  }
  private row(id: string) {
    return this.storage.sql
      .exec<FileRow>('SELECT * FROM cloud_files WHERE id=?', id)
      .toArray()[0]
  }
  private required(id: string): FileRow {
    return this.row(id) ?? fail(404, 'File not found')
  }
  usage(): number {
    const row = this.storage.sql
      .exec<{ used: number }>('SELECT used FROM cloud_capacity WHERE id=1')
      .one()
    return row.used
  }
  reserve(
    creatorOwnerId: string,
    name: string,
    size: number,
    now: number,
    request?: InputScope,
    idempotencyKey?: string,
  ): CloudFile {
    nowValue(now)
    identity(creatorOwnerId, 'upload owner')
    if (request) {
      identity(request.ownerId, 'file owner')
      identity(request.requestId, 'upload request')
    }
    if (idempotencyKey !== undefined)
      identity(idempotencyKey, 'idempotency key')
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      !name.isWellFormed() ||
      name === '.' ||
      name === '..' ||
      /[\/\\\x00-\x1f\x7f]/.test(name) ||
      new TextEncoder().encode(name).length > 255
    )
      fail(400, 'Invalid filename')
    if (!Number.isSafeInteger(size) || size < 0)
      fail(400, 'Invalid upload size')
    if (size > cloudLimits.maxFileBytes)
      fail(413, 'File exceeds the 100 MB limit')
    const ownerId = request?.ownerId ?? creatorOwnerId
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql
      if (idempotencyKey !== undefined) {
        const retired = sql
          .exec(
            'SELECT 1 FROM cloud_retired_requests WHERE creatorOwnerId=? AND requestKey=? AND expiresAt>?',
            creatorOwnerId,
            idempotencyKey,
            now,
          )
          .toArray()
        if (retired.length)
          fail(410, 'The previous upload was removed. Use a new upload key.')
        const existing = sql
          .exec<FileRow>(
            'SELECT * FROM cloud_files WHERE creatorOwnerId=? AND idempotencyKey=?',
            creatorOwnerId,
            idempotencyKey,
          )
          .toArray()[0]
        if (existing) {
          if (
            existing.name !== name ||
            existing.size !== size ||
            existing.ownerId !== ownerId ||
            existing.requestId !== (request?.requestId ?? null)
          )
            fail(409, 'Idempotency key already belongs to another upload')
          if (existing.expiresAt <= now || existing.state === 'deleting')
            fail(410, 'Upload expired or was deleted')
          return file(existing)
        }
      }
      const before = this.usage(),
        after = before + size
      if (after > cloudLimits.capacityBytes)
        fail(507, 'Cloud storage capacity reached')
      const id = crypto.randomUUID(),
        key = 'files/' + id
      sql.exec(
        `INSERT INTO cloud_files(id,key,ownerId,creatorOwnerId,requestId,name,size,state,createdAt,expiresAt,idempotencyKey)
        VALUES(?,?,?,?,?,?,?,'reserved',?,?,?)`,
        id,
        key,
        ownerId,
        creatorOwnerId,
        request?.requestId ?? null,
        name,
        size,
        now,
        now + cloudLimits.pendingMs,
        idempotencyKey ?? null,
      )
      sql.exec('UPDATE cloud_capacity SET used=? WHERE id=1', after)
      if (
        before < cloudLimits.highWaterBytes &&
        after >= cloudLimits.highWaterBytes
      )
        sql.exec(
          'INSERT INTO cloud_capacity_alerts(id,bytes,createdAt) VALUES(?,?,?)',
          crypto.randomUUID(),
          after,
          now,
        )
      return file(this.required(id))
    })
  }
  own(ownerId: string, id: string): CloudFile | null {
    const row = this.row(id)
    return row?.ownerId === ownerId ? file(row) : null
  }
  uploadBy(creatorOwnerId: string, id: string): CloudFile | null {
    const row = this.row(id)
    return row?.creatorOwnerId === creatorOwnerId ? file(row) : null
  }
  ready(id: string, now: number): CloudFile | null {
    const row = this.row(id)
    return row?.state === 'ready' && row.expiresAt > now ? file(row) : null
  }
  list(
    ownerId: string,
    now: number,
    limit = 100,
    before?: { createdAt: number; id: string },
  ): CloudFile[] {
    batchLimit(limit)
    const cutoff = before?.createdAt ?? Number.MAX_SAFE_INTEGER
    return this.storage.sql
      .exec<FileRow>(
        `SELECT * FROM cloud_files WHERE ownerId=? AND state='ready' AND expiresAt>?
       AND (createdAt < ? OR (createdAt = ? AND id < ?)) ORDER BY createdAt DESC,id DESC LIMIT ?`,
        ownerId,
        now,
        cutoff,
        cutoff,
        before?.id ?? '',
        limit,
      )
      .toArray()
      .map(file)
  }
  private uploadClaim(
    owner: string,
    id: string,
    now: number,
    operation: 'create' | 'complete',
  ): UploadClaim {
    nowValue(now)
    return this.storage.transactionSync(() => {
      const row = this.required(id)
      if (row.creatorOwnerId !== owner) fail(404, 'Upload not found')
      if (row.expiresAt <= now || row.state === 'deleting')
        fail(410, 'Upload expired or was deleted')
      if (
        row.state === 'ready' ||
        (operation === 'create' && row.state === 'uploading')
      )
        return { file: file(row), token: null, reconcileFirst: false }
      const initial = operation === 'create' ? 'reserved' : 'uploading'
      const active = operation === 'create' ? 'creating' : 'completing'
      if (row.state !== initial && row.state !== active)
        fail(409, 'Upload is not in the required state')
      if (row.leaseUntil > now)
        fail(409, 'Another storage action is in progress')
      const token = crypto.randomUUID()
      this.storage.sql.exec(
        'UPDATE cloud_files SET state=?,claimToken=?,leaseUntil=? WHERE id=?',
        active,
        token,
        now + cloudLimits.claimMs,
        id,
      )
      return {
        file: file(this.required(id)),
        token,
        reconcileFirst: row.state === active,
      }
    })
  }
  claimCreate(creatorOwnerId: string, id: string, now: number) {
    return this.uploadClaim(creatorOwnerId, id, now, 'create')
  }
  claimComplete(creatorOwnerId: string, id: string, now: number) {
    return this.uploadClaim(creatorOwnerId, id, now, 'complete')
  }
  attach(
    id: string,
    creatorOwnerId: string,
    uploadId: string,
    token: string,
    now: number,
  ): CloudFile {
    if (typeof uploadId !== 'string' || !uploadId || uploadId.length > 2048)
      fail(400, 'Invalid multipart upload ID')
    nowValue(now)
    return this.storage.transactionSync(() => {
      const row = this.required(id)
      if (row.creatorOwnerId !== creatorOwnerId) fail(404, 'Upload not found')
      if (
        row.state === 'uploading' &&
        row.uploadId === uploadId &&
        row.expiresAt > now
      )
        return file(row)
      if (row.state !== 'creating' || !token || row.claimToken !== token)
        fail(409, 'Upload creation claim is stale')
      // Even a long-running creation that just expired must retain the remote ID for cleanup.
      this.storage.sql.exec(
        "UPDATE cloud_files SET state='uploading',uploadId=?,claimToken=NULL,leaseUntil=0 WHERE id=?",
        uploadId,
        id,
      )
      return file(this.required(id))
    })
  }
  publish(id: string, token: string, now: number): CloudFile {
    nowValue(now)
    return this.storage.transactionSync(() => {
      const row = this.required(id)
      if (row.expiresAt <= now || row.state === 'deleting')
        fail(410, 'Upload expired or was deleted')
      if (row.state === 'ready' && token && row.doneToken === token)
        return file(row)
      if (row.state !== 'completing' || !token || row.claimToken !== token)
        fail(409, 'Upload completion claim is stale')
      this.storage.sql.exec(
        "UPDATE cloud_files SET state='ready',expiresAt=?,doneToken=?,claimToken=NULL,leaseUntil=0 WHERE id=?",
        now + cloudLimits.retentionMs,
        token,
        id,
      )
      return file(this.required(id))
    })
  }
  releaseClaim(id: string, token: string, retryAt = 0): boolean {
    nowValue(retryAt)
    const changed = this.storage.sql.exec(
      'UPDATE cloud_files SET claimToken=NULL,leaseUntil=? WHERE id=? AND claimToken=? RETURNING id',
      retryAt,
      id,
      token,
    )
    return changed.toArray().length === 1
  }
  private deleting(row: FileRow, now: number): CleanupClaim {
    if (row.leaseUntil > now) fail(409, 'Another storage action is in progress')
    let cleanup: Cleanup
    switch (row.state) {
      case 'reserved':
        cleanup = 'none'
        break
      case 'creating':
        cleanup = 'discover'
        break
      case 'uploading':
      case 'completing':
        cleanup = 'multipart'
        break
      case 'ready':
        cleanup = 'object'
        break
      case 'deleting':
        cleanup = row.cleanup ?? fail(500, 'Cleanup metadata missing')
        break
    }
    const token = crypto.randomUUID()
    this.storage.sql.exec(
      "UPDATE cloud_files SET state='deleting',cleanup=?,claimToken=?,leaseUntil=? WHERE id=?",
      cleanup,
      token,
      now + cloudLimits.claimMs,
      row.id,
    )
    return { file: file(this.required(row.id)), token, cleanup }
  }
  claimDelete(actor: string, id: string, now: number): CleanupClaim {
    nowValue(now)
    return this.storage.transactionSync(() => {
      const row = this.required(id)
      if (
        row.ownerId !== actor &&
        !(
          row.creatorOwnerId === actor &&
          row.state !== 'ready' &&
          row.cleanup !== 'object'
        )
      )
        fail(404, 'File not found')
      return this.deleting(row, now)
    })
  }
  claimCleanup(now: number, limit = 25): CleanupClaim[] {
    nowValue(now)
    batchLimit(limit)
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(
        'DELETE FROM cloud_retired_requests WHERE rowid IN (SELECT rowid FROM cloud_retired_requests WHERE expiresAt<=? LIMIT 100)',
        now,
      )
      const rows = this.storage.sql
        .exec<FileRow>(
          `SELECT * FROM cloud_files WHERE (state='deleting' OR expiresAt<=?) AND leaseUntil<=?
        ORDER BY leaseUntil,expiresAt,id LIMIT ?`,
          now,
          now,
          limit,
        )
        .toArray()
      return rows.map((row) => this.deleting(row, now))
    })
  }
  holdsCleanup(id: string, token: string): boolean {
    const row = this.row(id)
    return row?.state === 'deleting' && row.claimToken === token
  }
  // Called only after the orchestrator confirms all R2 operations for this claim.
  removed(id: string, token: string, now = Date.now()): boolean {
    nowValue(now)
    return this.storage.transactionSync(() => {
      const row = this.row(id)
      if (!row) return false
      if (row.state !== 'deleting' || !token || row.claimToken !== token)
        fail(409, 'Cleanup claim is stale')
      if (row.idempotencyKey !== null) {
        this.storage.sql.exec(
          `INSERT INTO cloud_retired_requests(creatorOwnerId,requestKey,expiresAt) VALUES(?,?,?)
          ON CONFLICT(creatorOwnerId,requestKey) DO UPDATE SET expiresAt=excluded.expiresAt`,
          row.creatorOwnerId,
          row.idempotencyKey,
          now + cloudLimits.pendingMs,
        )
      }
      this.storage.sql.exec('DELETE FROM cloud_files WHERE id=?', id)
      this.storage.sql.exec(
        'UPDATE cloud_capacity SET used=used-? WHERE id=1',
        row.size,
      )
      return true
    })
  }
  claimAlerts(now: number, limit = 10): CapacityAlert[] {
    nowValue(now)
    batchLimit(limit)
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql
      const rows = sql
        .exec<{
          id: string
          bytes: number
          createdAt: number
          attempts: number
        }>(
          'SELECT id,bytes,createdAt,attempts FROM cloud_capacity_alerts WHERE availableAt<=? ORDER BY createdAt,id LIMIT ?',
          now,
          limit,
        )
        .toArray()
      return rows.map((row) => {
        const token = crypto.randomUUID(),
          attempts = row.attempts + 1
        sql.exec(
          'UPDATE cloud_capacity_alerts SET token=?,attempts=?,availableAt=? WHERE id=?',
          token,
          attempts,
          now + cloudLimits.claimMs,
          row.id,
        )
        return { ...row, token, attempts }
      })
    })
  }
  ackAlert(id: string, token: string): boolean {
    return (
      this.storage.sql
        .exec(
          'DELETE FROM cloud_capacity_alerts WHERE id=? AND token=? RETURNING id',
          id,
          token,
        )
        .toArray().length === 1
    )
  }
  releaseAlert(id: string, token: string, retryAt = 0): boolean {
    nowValue(retryAt)
    return (
      this.storage.sql
        .exec(
          'UPDATE cloud_capacity_alerts SET token=NULL,availableAt=? WHERE id=? AND token=? RETURNING id',
          retryAt,
          id,
          token,
        )
        .toArray().length === 1
    )
  }
}
