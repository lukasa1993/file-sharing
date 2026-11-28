import {
  partBytes,
  partCount,
  partLength,
  TransferError,
  type FileInfo,
  type Part,
  type TransferAdapter,
  type UploadInput,
  type UploadSession,
} from '../shared/transfers.ts'
import type { CloudCatalog, CloudFile, CleanupClaim } from './catalog.ts'
import type { R2Transfers } from './r2.ts'
import type { CloudSharing } from './sharing.ts'

type Storage = Pick<
  R2Transfers,
  | 'create'
  | 'discover'
  | 'part'
  | 'complete'
  | 'abort'
  | 'head'
  | 'remove'
  | 'download'
>
type Grants = Pick<CloudSharing, 'authorizeUpload' | 'authorizeUploadId'>
type Actor = { id: string; email: string }
const missing = () => new TransferError(404, 'File not found.')
const unavailable = () =>
  new TransferError(
    503,
    'Cloud storage did not confirm the operation. Retry shortly.',
  )
const info = ({ id, name, size, expiresAt }: CloudFile): FileInfo => ({
  id,
  name,
  size,
  expiresAt,
})

// Requests share one catalog instance in the singleton Durable Object. The durable
// tokens fence interrupted workers; this bounded queue serializes live external calls
// even when a slow R2 request outlasts its SQL lease.
type Lock = { tail: Promise<void>; count: number }
const locks = new WeakMap<CloudCatalog, Map<string, Lock>>()
async function serialize<T>(
  catalog: CloudCatalog,
  id: string,
  work: () => Promise<T>,
): Promise<T> {
  let active = locks.get(catalog)
  if (!active) {
    active = new Map()
    locks.set(catalog, active)
  }
  const previous = active.get(id)
  if ((!previous && active.size >= 256) || (previous && previous.count >= 8))
    throw new TransferError(429, 'Storage operations are busy. Retry shortly.')
  const lock = previous ?? { tail: Promise.resolve(), count: 0 }
  lock.count++
  const prior = lock.tail
  const turn = Promise.withResolvers<void>()
  lock.tail = turn.promise
  active.set(id, lock)
  try {
    await prior
    return await work()
  } finally {
    turn.resolve()
    if (--lock.count === 0) active.delete(id)
  }
}
async function dispose(
  catalog: CloudCatalog,
  r2: Storage,
  claim: CleanupClaim,
  now: () => number,
) {
  const { file, token, cleanup } = claim
  if (!catalog.holdsCleanup(file.id, token)) return
  try {
    if (cleanup === 'discover') {
      for (const id of await r2.discover(file.key)) await r2.abort(file.key, id)
    } else if (cleanup === 'multipart') {
      if (!file.uploadId) throw unavailable()
      await r2.abort(file.key, file.uploadId)
    }
    // A response-lost completion can leave an object after its MPU disappears.
    if (cleanup !== 'none') {
      await r2.remove(file.key)
      if (await r2.head(file.key)) throw unavailable()
    }
    catalog.removed(file.id, token, now())
  } catch {
    catalog.releaseClaim(file.id, token, now() + 60_000)
    throw unavailable()
  }
}
export async function cleanupFile(
  catalog: CloudCatalog,
  r2: Storage,
  claim: CleanupClaim,
  now: () => number = Date.now,
) {
  return serialize(catalog, claim.file.id, () =>
    dispose(catalog, r2, claim, now),
  )
}

export class CloudTransferAdapter implements TransferAdapter {
  constructor(
    private readonly catalog: CloudCatalog,
    private readonly r2: Storage,
    private readonly sharing: Grants,
    private readonly actor: Actor,
    private readonly now: () => number = Date.now,
  ) {}

  private upload(id: string) {
    const row = this.catalog.uploadBy(this.actor.id, id)
    if (!row) throw missing()
    return row
  }
  private allowedFile(row: CloudFile) {
    const now = this.now()
    if (row.expiresAt <= now || row.state === 'deleting')
      throw new TransferError(410, 'Upload expired or was deleted.')
    if (!row.requestId) return row.expiresAt
    const grant = this.sharing.authorizeUploadId(row.requestId, this.actor, now)
    if (grant.ownerId !== row.ownerId) throw missing()
    return Math.min(row.expiresAt, grant.expiresAt ?? row.expiresAt)
  }
  private assertSignable(expiresAt: number, error: () => TransferError) {
    if (Math.floor(expiresAt / 1000) <= Math.floor(this.now() / 1000))
      throw error()
  }
  private async sign(
    expiresAt: number,
    error: () => TransferError,
    presign: () => Promise<string>,
  ) {
    this.assertSignable(expiresAt, error)
    try {
      return await presign()
    } catch (cause) {
      // The storage signer samples its own clock after the precheck.
      if (cause instanceof RangeError) this.assertSignable(expiresAt, error)
      throw cause
    }
  }
  async create(input: UploadInput): Promise<UploadSession> {
    if (input.target !== undefined)
      throw new TransferError(
        400,
        'Cloud uploads do not take a filesystem destination.',
      )
    const now = this.now()
    const grant = input.requestAlias
      ? this.sharing.authorizeUpload(input.requestAlias, this.actor, now)
      : undefined
    const row = this.catalog.reserve(
      this.actor.id,
      input.name,
      input.size,
      now,
      grant,
      input.idempotencyKey,
    )
    return serialize(this.catalog, row.id, async () => {
      this.allowedFile(this.upload(row.id))
      const claim = this.catalog.claimCreate(this.actor.id, row.id, this.now())
      if (claim.token) {
        try {
          let remoteId: string | undefined
          if (claim.reconcileFirst) {
            const found = await this.r2.discover(row.key)
            remoteId = found[0]
            for (const extra of found.slice(1))
              await this.r2.abort(row.key, extra)
          }
          if (!remoteId) {
            this.allowedFile(this.upload(row.id))
            remoteId = await this.r2.create(row.key, row.name)
          }
          const attached = this.catalog.attach(
            row.id,
            this.actor.id,
            remoteId,
            claim.token,
            this.now(),
          )
          try {
            this.allowedFile(attached)
          } catch (error) {
            const undo = this.catalog.claimDelete(
              this.actor.id,
              row.id,
              this.now(),
            )
            await dispose(this.catalog, this.r2, undo, this.now)
            throw error
          }
        } catch (error) {
          this.catalog.releaseClaim(row.id, claim.token)
          if (error instanceof TransferError) throw error
          throw unavailable()
        }
      }
      return { transport: 'multipart', id: row.id, partSize: partBytes }
    })
  }
  async part(id: string, number: number) {
    const row = this.upload(id)
    const expiry = this.allowedFile(row)
    if (row.state !== 'uploading' || !row.uploadId)
      throw new TransferError(409, 'Upload is not accepting parts.')
    const length = partLength(row.size, number)
    const uploadId = row.uploadId
    const expired = () =>
      new TransferError(410, 'Upload URL authorization has expired.')
    const url = await this.sign(expiry, expired, () =>
      this.r2.part(row.key, uploadId, number, length, expiry),
    )
    const checked = this.upload(id)
    if (
      this.allowedFile(checked) < expiry ||
      checked.state !== 'uploading' ||
      checked.uploadId !== row.uploadId
    )
      throw new TransferError(409, 'Upload changed before signing finished.')
    this.assertSignable(expiry, expired)
    return url
  }
  async complete(id: string, parts: Part[]): Promise<FileInfo> {
    this.upload(id)
    return serialize(this.catalog, id, async () => {
      const row = this.upload(id)
      this.allowedFile(row)
      if (row.state === 'ready') return info(row)
      if (
        parts.length !== partCount(row.size) ||
        parts.some((part, i) => part.partNumber !== i + 1 || !part.etag)
      )
        throw new TransferError(400, 'Provide all upload parts in order.')
      const claim = this.catalog.claimComplete(this.actor.id, id, this.now())
      if (!claim.token) return info(claim.file)
      const token = claim.token
      try {
        if (!row.uploadId) throw unavailable()
        let stored = claim.reconcileFirst ? await this.r2.head(row.key) : null
        if (!stored) {
          this.allowedFile(this.upload(id))
          try {
            await this.r2.complete(row.key, row.uploadId, parts)
          } catch (error) {
            // R2 may have completed the upload even if its response never arrived.
            stored = await this.r2.head(row.key)
            if (!stored) throw error
          }
          stored ??= await this.r2.head(row.key)
        }
        if (!stored) throw unavailable()
        try {
          this.allowedFile(this.upload(id))
          if (stored.size !== row.size)
            throw new TransferError(
              409,
              'The stored file size differs from the reservation.',
            )
        } catch (error) {
          if (this.catalog.releaseClaim(id, token)) {
            const undo = this.catalog.claimDelete(this.actor.id, id, this.now())
            await dispose(this.catalog, this.r2, undo, this.now)
          }
          throw error
        }
        return info(this.catalog.publish(id, token, this.now()))
      } catch (error) {
        this.catalog.releaseClaim(id, token)
        if (error instanceof TransferError) throw error
        throw unavailable()
      }
    })
  }
  async cancel(id: string) {
    this.upload(id)
    return serialize(this.catalog, id, async () => {
      const row = this.upload(id)
      if (row.state === 'ready')
        throw new TransferError(409, 'Completed uploads cannot be canceled.')
      return dispose(
        this.catalog,
        this.r2,
        this.catalog.claimDelete(this.actor.id, id, this.now()),
        this.now,
      )
    })
  }
  async remove(id: string) {
    if (!this.catalog.own(this.actor.id, id)) throw missing()
    return serialize(this.catalog, id, async () => {
      const row = this.catalog.own(this.actor.id, id)
      if (!row || (row.state !== 'ready' && row.state !== 'deleting'))
        throw missing()
      return dispose(
        this.catalog,
        this.r2,
        this.catalog.claimDelete(this.actor.id, id, this.now()),
        this.now,
      )
    })
  }
  async list(
    url: URL,
  ): Promise<{ files: FileInfo[]; nextCursor: string | null }> {
    const limit = Number(url.searchParams.get('limit') ?? 100)
    const cursor = url.searchParams.get('cursor')
    let before: { createdAt: number; id: string } | undefined
    if (cursor !== null) {
      const match =
        /^(\d{1,16})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
          cursor,
        )
      const createdAt = Number(match?.[1])
      if (!match?.[2] || !Number.isSafeInteger(createdAt))
        throw new TransferError(400, 'Invalid file list cursor.')
      before = { createdAt, id: match[2] }
    }
    const now = this.now()
    const rows = this.catalog.list(this.actor.id, now, limit, before)
    const last = rows.at(-1)
    const more =
      rows.length === limit &&
      last &&
      this.catalog.list(this.actor.id, now, 1, last).length > 0
    return {
      files: rows.map(info),
      nextCursor: more && last ? last.createdAt + '.' + last.id : null,
    }
  }
  async download(id: string) {
    const row = this.catalog.ready(id, this.now())
    if (!row || row.ownerId !== this.actor.id) throw missing()
    const url = await this.sign(row.expiresAt, missing, () =>
      this.r2.download(row.key, row.expiresAt),
    )
    if (!this.catalog.ready(id, this.now())) throw missing()
    this.assertSignable(row.expiresAt, missing)
    return url
  }
}
