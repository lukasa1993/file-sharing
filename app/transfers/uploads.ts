import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { Effect, type Clock } from 'effect'
import { AppError, type Guard, type ResourceRef } from '../contracts.ts'
import { attempt, runTask } from '../effects.ts'
import type { Filesystem } from '../filesystem/index.ts'
import {
  ActivityRegistry,
  preparationDigest,
  type PreparationTimeouts,
  type Activity,
  type TransferOptions,
} from './streams.ts'

export type UploadAccess = {
  actor: string
  guard: Guard
  base?: ResourceRef
  scope?: string
  cap?: number
  quota?: number
  getQuota?: () => number | null
  revalidate?: () => void
  location?: string
}
type Writer = {
  aborter: AbortController
  released: PromiseWithResolvers<void>
}

type Conflict = 'reject' | 'rename' | 'skip' | 'overwrite'
type Upload = {
  id: string
  actor: string
  scope: string
  mount: string
  segments: string
  bytes: number
  offset: number
  conflict: Conflict
  expected_digest: string | null
  expires: number
  state:
    | 'allocating'
    | 'receiving'
    | 'failed'
    | 'publishing'
    | 'completed'
    | 'cleaning'
    | 'skipping'
    | 'skipped'
    | 'expired'
  final_ref: string | null
  final_identity: string | null
}
const version = '1.0.0'
const common = { 'Tus-Resumable': version, 'Cache-Control': 'no-store' }
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const finalStates = new Set(['completed', 'skipped'])
const numberHeader = (value: string | null, header: string) => {
  if (
    value === null ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new AppError(400, 'Invalid ' + header)
  return Number(value)
}

function metadata(raw: string) {
  if (Buffer.byteLength(raw) > 8192)
    throw new AppError(400, 'Upload metadata is too long.')
  const result = new Map<string, string>()
  for (const field of raw.split(',')) {
    const match = /^([A-Za-z0-9_-]+)(?: ([A-Za-z0-9+/]*={0,2}))?$/.exec(
      field.trim(),
    )
    if (!match?.[1] || result.has(match[1]))
      throw new AppError(400, 'Invalid upload metadata.')
    const bytes = Buffer.from(match[2] ?? '', 'base64')
    if (
      bytes.toString('base64').replace(/=+$/, '') !==
      (match[2] ?? '').replace(/=+$/, '')
    )
      throw new AppError(400, 'Invalid upload metadata.')
    try {
      result.set(
        match[1],
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      )
    } catch {
      throw new AppError(400, 'Invalid UTF-8 in upload metadata.')
    }
  }
  return result
}
function parseRef(row: Upload): ResourceRef {
  return { mountId: row.mount, segments: JSON.parse(row.segments) }
}
function segment(name: string) {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[/\\\x00-\x1f\x7f]/.test(name) ||
    Buffer.byteLength(name) > 255
  )
    throw new AppError(400, 'Invalid upload destination.')
  return name
}

function progress(row: Upload) {
  return {
    ...common,
    'Upload-Offset': String(row.offset),
    'Upload-Length': String(row.bytes),
    'Upload-Expires': new Date(row.expires).toUTCString(),
    'Upload-State': row.state,
  }
}

export class Uploads {
  private readonly busy = new Set<string>()
  private readonly writers = new Map<string, Writer>()
  private readonly maxChunk: number
  private readonly ttl: number
  private recovered = false
  private cleaning = false
  constructor(
    readonly db: Database,
    readonly fs: Filesystem,
    readonly jobs: ActivityRegistry,
    options: Readonly<Required<TransferOptions>>,
    private readonly clock: Clock.Clock,
    private readonly timeouts: PreparationTimeouts,
  ) {
    this.maxChunk = options.maxChunkBytes
    this.ttl = options.uploadTtlMs
    db.exec(`CREATE TABLE IF NOT EXISTS transfer_uploads (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, scope TEXT NOT NULL, mount TEXT NOT NULL, segments TEXT NOT NULL,
      bytes INTEGER NOT NULL, offset INTEGER NOT NULL DEFAULT 0, conflict TEXT NOT NULL, expected_digest TEXT,
      expires INTEGER NOT NULL, state TEXT NOT NULL, final_ref TEXT, final_identity TEXT
    );
    CREATE TABLE IF NOT EXISTS transfer_storage_files(
      upload_id TEXT PRIMARY KEY, mount TEXT NOT NULL, identity TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_upload_mount ON transfer_uploads(mount,state);
    CREATE INDEX IF NOT EXISTS idx_upload_scope ON transfer_uploads(scope,state);
    CREATE INDEX IF NOT EXISTS idx_upload_actor ON transfer_uploads(actor,state);
    CREATE INDEX IF NOT EXISTS idx_upload_expiry ON transfer_uploads(state,expires);`)
  }
  private get(id: string) {
    const row = this.db
      .query<Upload, [string]>('SELECT * FROM transfer_uploads WHERE id=?')
      .get(id)
    if (!row) throw new AppError(404, 'Upload unavailable.')
    return row
  }
  private access(row: Upload, access: UploadAccess) {
    if (row.actor !== access.actor || row.scope !== (access.scope ?? ''))
      throw new AppError(404, 'Upload unavailable.')
    const ref = parseRef(row)
    if (
      access.base &&
      (ref.mountId !== access.base.mountId ||
        ref.segments.length <= access.base.segments.length ||
        !access.base.segments.every((s, i) => s === ref.segments[i]))
    )
      throw new AppError(404, 'Upload unavailable.')
    access.revalidate?.()
    access.guard('upload', ref)
    if (
      row.expires <= this.clock.currentTimeMillisUnsafe() ||
      row.state === 'expired' ||
      row.state === 'cleaning'
    )
      throw new AppError(410, 'Upload expired.')
    return ref
  }
  private checkBudget(row: Upload, access: UploadAccess, extra: number) {
    const quota = access.getQuota ? access.getQuota() : access.quota
    if (quota != null) {
      const used =
        this.db
          .query<{ n: number }, [string]>(
            `
        SELECT coalesce(sum(u.bytes),0) n FROM transfer_uploads u
        WHERE u.actor=? AND u.state IN ('allocating','receiving','failed','publishing','completed')
        AND (u.state != 'completed' OR NOT EXISTS (
          SELECT 1 FROM transfer_storage_files f JOIN fs_tracked_files t
          ON t.mount=f.mount AND t.identity=f.identity
          WHERE f.upload_id=u.id AND t.state='deleted'
        ))`,
          )
          .get(row.actor)?.n ?? 0
      if (extra > quota - used)
        throw new AppError(413, 'Upload capacity exceeded.')
    }
    if (row.scope && access.cap != null) {
      // An upload-only share counts accepted bytes over its lifetime, separately from storage.
      const used =
        this.db
          .query<{ n: number }, [string]>(
            `
        SELECT coalesce(sum(bytes),0) n FROM transfer_uploads WHERE scope=?
        AND state IN ('allocating','receiving','failed','publishing','completed')`,
          )
          .get(row.scope)?.n ?? 0
      if (extra > access.cap - used)
        throw new AppError(413, 'Upload capacity exceeded.')
    }
  }
  private reserve(row: Upload, access: UploadAccess, free: number) {
    this.checkBudget(row, access, row.bytes)
    const active = this.db
      .query<{ n: number; actorCount: number }, [string]>(
        `SELECT count(*) n,
      coalesce(sum(CASE WHEN actor=? THEN 1 ELSE 0 END),0) actorCount FROM transfer_uploads
      WHERE state IN ('allocating','receiving','failed','publishing')`,
      )
      .get(row.actor)
    if (active && (active.n >= 2048 || active.actorCount >= 128))
      throw new AppError(429, 'Too many unfinished uploads.')
    const held =
      this.db
        .query<{ n: number }, [string]>(
          `SELECT coalesce(sum(bytes-offset),0) n FROM transfer_uploads
      WHERE mount=? AND state IN ('allocating','receiving','failed','publishing')`,
        )
        .get(row.mount)?.n ?? 0
    if (row.bytes > free - held)
      throw new AppError(507, 'Insufficient storage space.')
    this.db
      .query(
        `INSERT INTO transfer_uploads(id,actor,scope,mount,segments,bytes,conflict,expected_digest,expires,state)
      VALUES(?,?,?,?,?,?,?,?,?,'allocating')`,
      )
      .run(
        row.id,
        row.actor,
        row.scope,
        row.mount,
        row.segments,
        row.bytes,
        row.conflict,
        row.expected_digest,
        row.expires,
      )
  }
  private async erase(row: Upload, end: 'expired' | 'deleted') {
    this.db
      .query("UPDATE transfer_uploads SET state='cleaning' WHERE id=?")
      .run(row.id)
    await this.fs.discardStage(row.mount, row.id)
    if (end === 'deleted')
      this.db.query('DELETE FROM transfer_uploads WHERE id=?').run(row.id)
    else
      this.db
        .query("UPDATE transfer_uploads SET state='expired' WHERE id=?")
        .run(row.id)
  }

  private async reconcile(row: Upload) {
    if (row.state === 'skipping') {
      await this.fs.discardStage(row.mount, row.id)
      this.db
        .query(
          "UPDATE transfer_uploads SET state='skipped',offset=bytes WHERE id=?",
        )
        .run(row.id)
      return
    }
    if (row.state !== 'publishing' || !row.final_ref || !row.final_identity)
      return
    if (
      await this.fs.recoverStage(
        JSON.parse(row.final_ref),
        row.id,
        row.final_identity,
      )
    ) {
      this.db
        .query(
          "UPDATE transfer_uploads SET state='completed',offset=bytes WHERE id=?",
        )
        .run(row.id)
    } else {
      // Never repeat a publication during recovery. The original owner must retry its final chunk.
      this.db
        .query(
          "UPDATE transfer_uploads SET state='receiving',final_ref=NULL,final_identity=NULL WHERE id=?",
        )
        .run(row.id)
    }
  }
  private failIncomplete(row: Upload): never {
    this.db
      .query(
        "UPDATE transfer_uploads SET state='failed' WHERE id=? AND state='receiving'",
      )
      .run(row.id)
    throw new AppError(
      409,
      'The partial upload is incomplete. Start a new upload.',
    )
  }

  private async resumeHandle(row: Upload) {
    try {
      return await this.fs.openStage(row.mount, row.id)
    } catch (error) {
      if (error instanceof AppError && error.status === 404)
        this.failIncomplete(row)
      throw error
    }
  }
  private async recoverStageLength(row: Upload) {
    const handle = await this.resumeHandle(row)
    try {
      const info = await handle.stat()
      if (info.size < row.offset) this.failIncomplete(row)
      if (info.size > row.offset) {
        await handle.truncate(row.offset)
        await handle.sync()
      }
    } finally {
      await handle.close()
    }
  }

  /** Runs at startup and periodically. Missing/unavailable mounts are retried without losing their records. */
  async cleanup() {
    if (this.cleaning) return
    this.cleaning = true
    const first = !this.recovered
    let last = ''
    try {
      while (true) {
        const rows = this.db
          .query<Upload, [string, number, number]>(
            `SELECT * FROM transfer_uploads WHERE id>? AND
          (state IN ('publishing','allocating','skipping','cleaning') OR (state IN ('receiving','failed') AND (expires<=? OR ?=1)))
          ORDER BY id LIMIT 100`,
          )
          .all(last, this.clock.currentTimeMillisUnsafe(), first ? 1 : 0)
        if (!rows.length) break
        for (let row of rows) {
          last = row.id
          if (this.busy.has(row.id)) continue
          this.busy.add(row.id)
          try {
            await this.reconcile(row)
            row = this.get(row.id)
            if (
              row.state === 'allocating' ||
              row.state === 'cleaning' ||
              (['receiving', 'failed'].includes(row.state) &&
                row.expires <= this.clock.currentTimeMillisUnsafe())
            )
              await this.erase(row, 'expired')
            else if (first && row.state === 'receiving')
              await this.recoverStageLength(row)
          } catch (error) {
            // Mounts can be temporarily absent; keep durable rows available for reconciliation.
            if (
              !(
                error instanceof AppError &&
                [404, 409, 503].includes(error.status)
              ) &&
              (error as NodeJS.ErrnoException).code !== 'ENOENT'
            )
              throw error
          } finally {
            this.busy.delete(row.id)
          }
        }
      }
      this.db
        .query(
          "DELETE FROM transfer_uploads WHERE state IN ('expired','skipped') AND expires < ?",
        )
        .run(this.clock.currentTimeMillisUnsafe() - this.ttl)
      this.recovered = true
    } finally {
      this.cleaning = false
    }
  }

  private async publish(
    request: Request,
    row: Upload,
    access: UploadAccess,
    handle: FileHandle,
    signal: AbortSignal,
  ) {
    if (
      row.expected_digest &&
      row.expected_digest !==
        (await preparationDigest(
          request,
          this.timeouts,
          handle,
          row.bytes,
          signal,
        ))
    )
      throw new AppError(422, 'The upload checksum did not match.')
    signal.throwIfAborted()
    const ref = this.access(row, access)
    const meta = !row.scope ? await handle.stat({ bigint: true }) : null
    const trackedIdentity =
      meta && meta.birthtimeNs > 0n
        ? [meta.dev, meta.ino, meta.birthtimeNs].join(':')
        : null
    // Once publication begins, finish its durable intent and acknowledgement despite client interruption.
    await runTask(
      Effect.uninterruptible(
        attempt(async () => {
          const result = await this.fs.commitStage(
            ref,
            row.id,
            access.guard,
            row.conflict,
            (chosen: ResourceRef, identity: string) => {
              this.access(row, access)
              this.checkBudget(row, access, 0)
              this.db.transaction(() => {
                if (trackedIdentity) {
                  this.db
                    .query(
                      'INSERT OR IGNORE INTO fs_tracked_files(mount,identity) VALUES(?,?)',
                    )
                    .run(row.mount, trackedIdentity)
                  this.db
                    .query(
                      `INSERT INTO transfer_storage_files(upload_id,mount,identity) VALUES(?,?,?)
                    ON CONFLICT(upload_id) DO UPDATE SET mount=excluded.mount,identity=excluded.identity`,
                    )
                    .run(row.id, row.mount, trackedIdentity)
                }
                this.db
                  .query(
                    "UPDATE transfer_uploads SET state='publishing',final_ref=?,final_identity=? WHERE id=?",
                  )
                  .run(JSON.stringify(chosen), identity, row.id)
              })()
            },
            undefined,
            () => {
              this.access(row, access)
              this.db
                .query(
                  "UPDATE transfer_uploads SET state='skipping' WHERE id=?",
                )
                .run(row.id)
            },
          )
          this.db
            .query(
              'UPDATE transfer_uploads SET state=?,offset=bytes WHERE id=?',
            )
            .run(result ? 'completed' : 'skipped', row.id)
        }),
      ),
    )
  }

  private async create(req: Request, access: UploadAccess) {
    const length = numberHeader(
      req.headers.get('Upload-Length'),
      'Upload-Length',
    )
    if (req.body) {
      const reader = req.body.getReader()
      try {
        for (;;) {
          req.signal.throwIfAborted()
          const part = await reader.read()
          if (part.done) break
          if (part.value.byteLength)
            throw new AppError(400, 'Send file bytes in PATCH requests.')
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
    const meta = metadata(req.headers.get('Upload-Metadata') ?? '')
    const rawPath = meta.get('path') ?? ''
    const dir = rawPath ? rawPath.split('/').map(segment) : []
    if (dir.length > 128)
      throw new AppError(400, 'Upload directory is too deep.')
    const mount = access.base?.mountId ?? meta.get('mount')
    if (!mount) throw new AppError(400, 'Missing upload mount.')
    const ref: ResourceRef = {
      mountId: mount,
      segments: [
        ...(access.base?.segments ?? []),
        ...dir,
        segment(meta.get('filename') ?? ''),
      ],
    }
    const selected = access.base ? 'rename' : (meta.get('conflict') ?? 'reject')
    if (!['reject', 'rename', 'skip', 'overwrite'].includes(selected))
      throw new AppError(400, 'Invalid conflict policy.')
    const sha = meta.get('sha256')?.toLowerCase() ?? null
    if (sha !== null && !/^[0-9a-f]{64}$/.test(sha))
      throw new AppError(400, 'Invalid SHA-256 digest.')
    const id = randomUUID()
    const row: Upload = {
      id,
      actor: access.actor,
      scope: access.scope ?? '',
      mount,
      segments: JSON.stringify(ref.segments),
      bytes: length,
      offset: 0,
      conflict: selected as Conflict,
      expected_digest: sha,
      expires: this.clock.currentTimeMillisUnsafe() + this.ttl,
      state: 'allocating',
      final_ref: null,
      final_identity: null,
    }
    this.access(row, access)
    const space = await this.fs.space(mount)
    this.busy.add(id)
    try {
      this.db.transaction(() => this.reserve(row, access, space.free))()
      try {
        const handle = await this.fs.createStage(ref, id, access.guard)
        try {
          await handle.sync()
          this.db
            .query("UPDATE transfer_uploads SET state='receiving' WHERE id=?")
            .run(id)
          if (!length) await this.publish(req, row, access, handle, req.signal)
        } finally {
          await handle.close()
        }
      } catch (error) {
        if (!['publishing', 'skipping'].includes(this.get(id).state))
          await this.erase(row, 'deleted')
        throw error
      }
      const location = new URL(access.location ?? '/_/uploads', req.url)
      location.pathname = location.pathname.replace(/\/$/, '') + '/' + id
      return new Response(null, {
        status: 201,
        headers: {
          ...progress(this.get(id)),
          Location: location.pathname + location.search,
        },
      })
    } finally {
      this.busy.delete(id)
    }
  }

  private async writeChunk(
    req: Request,
    row: Upload,
    handle: FileHandle,
    job: Activity,
  ) {
    const declared = req.headers.get('Content-Length')
    const maximum = Math.min(this.maxChunk, row.bytes - row.offset)
    if (declared !== null && numberHeader(declared, 'Content-Length') > maximum)
      throw new AppError(413, 'Chunk exceeds the available upload length.')
    if (!req.body) {
      if (declared !== null && Number(declared) > 0)
        throw new AppError(400, 'Incomplete request body.')
      return 0
    }
    const reader = req.body.getReader()
    let length = 0
    let cancellation: Promise<void> | undefined
    const abort = () => {
      cancellation = reader.cancel().catch(() => {})
    }
    job.signal.addEventListener('abort', abort, { once: true })
    try {
      for (;;) {
        job.signal.throwIfAborted()
        const item = await reader.read()
        job.signal.throwIfAborted()
        if (item.done) break
        if (item.value.byteLength > maximum - length)
          throw new AppError(413, 'Chunk exceeds the available upload length.')
        await job.meter(item.value.byteLength)
        let used = 0
        while (used < item.value.byteLength) {
          const { bytesWritten } = await handle.write(
            item.value,
            used,
            item.value.byteLength - used,
            row.offset + length + used,
          )
          if (!bytesWritten)
            throw new AppError(507, 'Could not write the file.')
          used += bytesWritten
        }
        length += item.value.byteLength
      }
      if (declared !== null && length !== Number(declared))
        throw new AppError(400, 'Incomplete request body.')
      return length
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    } finally {
      job.signal.removeEventListener('abort', abort)
      await cancellation
      reader.releaseLock()
    }
  }

  private async patch(
    req: Request,
    row: Upload,
    access: UploadAccess,
    writer: Writer,
  ) {
    if (req.headers.get('Content-Type') !== 'application/offset+octet-stream')
      throw new AppError(415, 'Expected application/offset+octet-stream.')
    const offset = numberHeader(
      req.headers.get('Upload-Offset'),
      'Upload-Offset',
    )
    if (row.state !== 'receiving' || offset !== row.offset)
      return new Response(null, { status: 409, headers: progress(row) })
    const job = this.jobs.start(
      'upload',
      access.actor,
      row.bytes,
      req,
      undefined,
      writer.aborter.signal,
    )
    job.initialBytes = offset
    try {
      const handle = await this.resumeHandle(row)
      try {
        const { size } = await handle.stat()
        if (size < offset) this.failIncomplete(row)
        if (size > offset) await handle.truncate(offset)
        try {
          const written = await this.writeChunk(req, row, handle, job)
          job.signal.throwIfAborted()
          await handle.sync()
          this.access(row, access)
          if (offset + written === row.bytes)
            await this.publish(req, row, access, handle, job.signal)
          else
            this.db
              .query(
                'UPDATE transfer_uploads SET offset=?,expires=? WHERE id=?',
              )
              .run(
                offset + written,
                this.clock.currentTimeMillisUnsafe() + this.ttl,
                row.id,
              )
        } catch (error) {
          // Once publication intent is recorded the handle may already name the committed file.
          if (this.get(row.id).state === 'receiving') {
            await handle.truncate(offset)
            await handle.sync()
          }
          if (job.signal.aborted)
            throw new AppError(
              409,
              'Upload interrupted. Resume from the confirmed offset.',
            )
          throw error
        }
      } finally {
        await handle.close()
      }
      return new Response(null, {
        status: 204,
        headers: progress(this.get(row.id)),
      })
    } finally {
      job.remove()
    }
  }

  async handle(req: Request, access: UploadAccess, id?: string) {
    try {
      if (req.method === 'OPTIONS')
        return new Response(null, {
          status: 204,
          headers: {
            ...common,
            'Tus-Version': version,
            'Tus-Extension': 'creation,termination,expiration',
          },
        })
      if (req.headers.get('Tus-Resumable') !== version)
        return new Response(null, {
          status: 412,
          headers: { ...common, 'Tus-Version': version },
        })
      if (!id && req.method === 'POST') return await this.create(req, access)
      if (!id || !uuid.test(id)) throw new AppError(404, 'Upload unavailable.')
      if (!['HEAD', 'PATCH', 'DELETE'].includes(req.method))
        throw new AppError(405, 'Unsupported upload method.')
      let row = this.get(id)
      this.access(row, access)
      const previous = this.writers.get(id)
      if (req.method === 'DELETE' && previous) {
        previous.aborter.abort(new Error('Upload terminated'))
        await previous.released.promise
        row = this.get(id)
        this.access(row, access)
      }
      if (this.busy.has(id)) {
        if (req.method === 'HEAD' && row.state === 'receiving')
          return new Response(null, { headers: progress(row) })
        return new Response(null, { status: 409, headers: progress(row) })
      }
      this.busy.add(id)
      const writer =
        req.method === 'PATCH'
          ? {
              aborter: new AbortController(),
              released: Promise.withResolvers<void>(),
            }
          : undefined
      if (writer) this.writers.set(id, writer)
      try {
        await this.reconcile(row)
        row = this.get(id)
        this.access(row, access)
        if (req.method === 'HEAD') {
          if (row.state === 'receiving') await this.recoverStageLength(row)
          return new Response(null, {
            status: row.state === 'failed' ? 409 : 200,
            headers: progress(row),
          })
        }
        if (req.method === 'DELETE') {
          if (finalStates.has(row.state))
            throw new AppError(409, 'This upload has already finished.')
          await this.erase(row, 'deleted')
          return new Response(null, { status: 204, headers: common })
        }
        if (!writer) throw new AppError(405, 'Unsupported upload method.')
        return await this.patch(req, row, access, writer)
      } finally {
        this.busy.delete(id)
        if (writer) {
          this.writers.delete(id)
          writer.released.resolve()
        }
      }
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      return new Response(req.method === 'HEAD' ? null : error.message, {
        status: error.status,
        headers:
          req.method === 'HEAD'
            ? common
            : { ...common, 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }
  }
}
