import { createHash, randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { Effect, Semaphore } from 'effect'
import { setTimeout as delay } from 'node:timers/promises'
import { AppError } from '../contracts.ts'

export type TransferOptions = {
  maxChunkBytes?: number
  maxConcurrent?: number
  perActorConcurrent?: number
  bytesPerSecond?: number
  uploadTtlMs?: number
}

export type ActiveTransfer = {
  id: string
  kind: 'upload' | 'download' | 'archive'
  actor: string
  bytes: number
  total: number | null
  startedAt: number
  bytesPerSecond: number
}

export class Activity {
  readonly id = randomUUID()
  readonly startedAt = Date.now()
  readonly aborter = new AbortController()
  readonly signal: AbortSignal
  bytes = 0
  initialBytes = 0
  private nextPermitAt = 0
  readonly finished = Promise.withResolvers<void>()

  constructor(
    readonly kind: ActiveTransfer['kind'],
    readonly actor: string,
    readonly total: number | null,
    signal: AbortSignal,
    readonly bandwidth: number,
    readonly remove: () => void,
  ) {
    this.signal = AbortSignal.any([signal, this.aborter.signal])
  }

  async meter(bytes: number) {
    this.signal.throwIfAborted()
    if (this.bandwidth > 0) {
      const now = performance.now()
      this.nextPermitAt =
        Math.max(now, this.nextPermitAt) + (1000 * bytes) / this.bandwidth
      // Allow one small leading quantum. Idle hashing, previews, or backpressure
      // must not accumulate bandwidth credit for a subsequent large burst.
      const wait = this.nextPermitAt - now - 125
      if (wait > 0) await delay(wait, undefined, { signal: this.signal })
    }
    this.signal.throwIfAborted()
    this.bytes += bytes
  }

  snapshot(): ActiveTransfer {
    return {
      id: this.id,
      kind: this.kind,
      actor: this.actor,
      bytes: this.initialBytes + this.bytes,
      total: this.total,
      startedAt: this.startedAt,
      bytesPerSecond: Math.round(
        (this.bytes * 1000) / Math.max(1, Date.now() - this.startedAt),
      ),
    }
  }
}

export class ActivityRegistry {
  private jobs = new Map<string, Activity>()
  private permits: Semaphore.Semaphore
  private stopping = false
  constructor(readonly options: TransferOptions) {
    this.permits = Semaphore.makeUnsafe(options.maxConcurrent ?? 32)
  }

  start(
    kind: ActiveTransfer['kind'],
    actor: string,
    total: number | null,
    req: Request,
    bandwidth?: number,
    termination?: AbortSignal,
  ) {
    if (this.stopping) throw new AppError(503, 'Transfers are stopping.')
    const actorJobs = [...this.jobs.values()].filter(
      (job) => job.actor === actor,
    ).length
    if (
      actorJobs >= (this.options.perActorConcurrent ?? 8) ||
      !Effect.runSync(this.permits.takeIfAvailable(1))
    ) {
      throw new AppError(429, 'Too many active transfers. Try again shortly.')
    }
    const rates = [this.options.bytesPerSecond ?? 0, bandwidth ?? 0].filter(
      (rate) => rate > 0,
    )
    const activity = new Activity(
      kind,
      actor,
      total,
      termination ? AbortSignal.any([req.signal, termination]) : req.signal,
      rates.length ? Math.min(...rates) : 0,
      () => {
        if (this.jobs.delete(activity.id)) {
          Effect.runSync(this.permits.release(1))
          activity.finished.resolve()
        }
      },
    )
    this.jobs.set(activity.id, activity)
    return activity
  }

  list() {
    return [...this.jobs.values()].map((job) => job.snapshot())
  }
  async shutdown() {
    this.stopping = true
    const jobs = [...this.jobs.values()]
    for (const job of jobs) job.aborter.abort(new Error('Server shutting down'))
    await Promise.all(jobs.map((job) => job.finished.promise))
  }
  cancel(id: string) {
    const job = this.jobs.get(id)
    if (!job) return false
    job.aborter.abort(new Error('Transfer cancelled'))
    return true
  }
}

/** Explicit positional reads allow a digest, range read, and MIME inspection on one pinned handle. */
export async function* chunks(
  handle: FileHandle,
  start: number,
  end: number,
  signal?: AbortSignal,
) {
  let offset = start
  while (offset < end) {
    signal?.throwIfAborted()
    const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, end - offset))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    if (!bytesRead) throw new AppError(409, 'The file changed during transfer.')
    offset += bytesRead
    yield buffer.subarray(0, bytesRead)
  }
}

export type PreparationTimeouts = WeakMap<Request, (preparing: boolean) => void>

export async function preparationDigest(
  request: Request,
  timeouts: PreparationTimeouts,
  handle: FileHandle,
  size: number,
  signal: AbortSignal,
) {
  const switchTimeout = timeouts.get(request)
  try {
    switchTimeout?.(true)
    return await digest(handle, size, signal)
  } finally {
    timeouts.delete(request)
    switchTimeout?.(false)
  }
}

async function digest(handle: FileHandle, size: number, signal?: AbortSignal) {
  const hash = createHash('sha256')
  // The digest finishes consuming each read synchronously, so a large file
  // needs only one allocation, independently of how many blocks it contains.
  const buffer = Buffer.allocUnsafe(Math.min(size, 1024 * 1024))
  let offset = 0
  while (offset < size) {
    signal?.throwIfAborted()
    const length = Math.min(buffer.byteLength, size - offset)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    if (!bytesRead) throw new AppError(409, 'The file changed during transfer.')
    hash.update(buffer.subarray(0, bytesRead))
    offset += bytesRead
  }
  return hash.digest('hex')
}

export async function readBounded(handle: FileHandle, size: number) {
  const result = Buffer.alloc(size)
  let offset = 0
  for await (const bytes of chunks(handle, 0, size)) {
    result.set(bytes, offset)
    offset += bytes.length
  }
  return result
}

async function* pacedChunks(source: AsyncGenerator<Uint8Array>, rate: number) {
  const quantum = Math.max(1, Math.floor(rate / 8))
  for await (const chunk of source) {
    for (let offset = 0; offset < chunk.byteLength; offset += quantum) {
      yield chunk.subarray(offset, offset + quantum)
    }
  }
}

/** highWaterMark 0 keeps file reads behind the HTTP consumer's demand. */
export function bodyStream(
  source: AsyncGenerator<Uint8Array>,
  activity: Activity,
  release: () => Promise<void>,
  onBytes?: (bytes: number) => void,
): ReadableStream<Uint8Array> {
  const output =
    activity.bandwidth > 0 ? pacedChunks(source, activity.bandwidth) : source
  let closed = false
  let pendingBytes = 0
  const flush = () => {
    if (pendingBytes) onBytes?.(pendingBytes)
    pendingBytes = 0
  }
  let controller: ReadableStreamDefaultController<Uint8Array>
  const releaseResources = async () => {
    closed = true
    activity.signal.removeEventListener('abort', abort)
    try {
      try {
        flush()
      } finally {
        await output.return(undefined)
      }
    } finally {
      try {
        await release()
      } finally {
        activity.remove()
      }
    }
  }
  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= releaseResources()
    return closing
  }
  const abort = () => {
    if (closed) return
    controller.error(new Error('Transfer cancelled'))
    // Registry shutdown also waits for activity.remove() in releaseResources.
    closing = close().catch(() =>
      console.warn('Interrupted transfer cleanup failed.'),
    )
  }
  return new ReadableStream(
    {
      start(c) {
        controller = c
        activity.signal.addEventListener('abort', abort, { once: true })
        if (activity.signal.aborted) abort()
      },
      async pull(c) {
        try {
          const item = await output.next()
          if (closed) return
          if (item.done) {
            await close()
            c.close()
            return
          }
          await activity.meter(item.value.byteLength)
          if (closed) return
          c.enqueue(item.value)
          pendingBytes += item.value.byteLength
          if (pendingBytes >= 8 * 1024 * 1024) flush()
        } catch (err) {
          if (!closed) c.error(err)
          await close()
        }
      },
      cancel() {
        activity.signal.removeEventListener('abort', abort)
        activity.aborter.abort(new Error('Download cancelled'))
        return close()
      },
    },
    { highWaterMark: 0 },
  )
}
