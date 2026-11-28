import { createHash, randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { Clock, Duration, Effect, Semaphore } from 'effect'
import { AppError } from '../contracts.ts'

export type TransferOptions = {
  maxChunkBytes?: number
  maxConcurrent?: number
  perActorConcurrent?: number
  bytesPerSecond?: number
  uploadTtlMs?: number
}

export const defaultTransferLimits: Readonly<Required<TransferOptions>> =
  Object.freeze({
    maxChunkBytes: 16 * 1024 * 1024,
    maxConcurrent: 32,
    perActorConcurrent: 8,
    bytesPerSecond: 0,
    uploadTtlMs: 24 * 60 * 60 * 1000,
  })

export type ActiveTransfer = {
  id: string
  kind: 'upload' | 'download' | 'archive' | 'copy' | 'move'
  actor: string
  bytes: number
  total: number | null
  startedAt: number
  bytesPerSecond: number
}

// A single leading 125ms quantum keeps the first byte responsive. An
// interrupted waiter releases the turn before its unused allowance is charged.
class BandwidthSchedule {
  private nextPermitAt = 0
  private readonly turn = Semaphore.makeUnsafe(1)
  constructor(private readonly clock: Clock.Clock) {}
  get idle() {
    return (
      this.nextPermitAt <= Number(this.clock.monotonicTimeNanosUnsafe()) / 1e6
    )
  }
  take(bytes: number, rate: number) {
    return this.turn.withPermit(
      Effect.suspend(() => {
        const now = Number(this.clock.monotonicTimeNanosUnsafe()) / 1e6
        const end = Math.max(now, this.nextPermitAt) + (bytes * 1000) / rate
        const wait = end - now - 125
        const ready =
          wait > 0
            ? this.clock.sleep(Duration.millis(Math.ceil(wait)))
            : Effect.void
        return Effect.andThen(ready, () =>
          Effect.sync(() => {
            this.nextPermitAt = end
          }),
        )
      }),
    )
  }
}
export type BandwidthBudget = { key: string; rate: number | (() => number) }
type RateLimit = { rate: BandwidthBudget['rate']; schedule: BandwidthSchedule }
function currentRate(limit: RateLimit) {
  return typeof limit.rate === 'number' ? limit.rate : limit.rate()
}

export class Activity {
  readonly id = randomUUID()
  readonly startedAt = Date.now()
  readonly aborter = new AbortController()
  readonly signal: AbortSignal
  bytes = 0
  initialBytes = 0
  readonly finished = Promise.withResolvers<void>()

  constructor(
    readonly kind: ActiveTransfer['kind'],
    readonly actor: string,
    readonly total: number | null,
    signal: AbortSignal,
    private limits: readonly RateLimit[],
    readonly remove: () => void,
  ) {
    this.signal = AbortSignal.any([signal, this.aborter.signal])
  }

  quantum(maximum: number) {
    let size = maximum
    for (const limit of this.limits) {
      const rate = currentRate(limit)
      if (rate > 0) size = Math.min(size, Math.max(1, Math.floor(rate / 8)))
    }
    return size
  }

  async meter(bytes: number) {
    this.signal.throwIfAborted()
    for (const limit of this.limits) {
      const rate = currentRate(limit)
      if (rate <= 0) continue
      await Effect.runPromise(limit.schedule.take(bytes, rate), {
        signal: this.signal,
      })
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
  private readonly actorBandwidth = new Map<
    string,
    { schedule: BandwidthSchedule; active: number }
  >()
  private permits: Semaphore.Semaphore
  private stopping = false
  constructor(
    readonly options: Readonly<
      Required<TransferOptions>
    > = defaultTransferLimits,
    private readonly clock: Clock.Clock = Clock.Clock.defaultValue(),
  ) {
    this.permits = Semaphore.makeUnsafe(options.maxConcurrent)
  }

  start(
    kind: ActiveTransfer['kind'],
    actor: string,
    total: number | null,
    req: Request,
    bandwidth?: number | readonly BandwidthBudget[],
    termination?: AbortSignal,
  ) {
    if (this.stopping) throw new AppError(503, 'Transfers are stopping.')
    const actorJobs = [...this.jobs.values()].filter(
      (job) => job.actor === actor,
    ).length
    if (
      actorJobs >= this.options.perActorConcurrent ||
      !Effect.runSync(this.permits.takeIfAvailable(1))
    ) {
      throw new AppError(429, 'Too many active transfers. Try again shortly.')
    }
    for (const [key, budget] of this.actorBandwidth) {
      if (!budget.active && budget.schedule.idle)
        this.actorBandwidth.delete(key)
    }
    const limits: RateLimit[] = []
    if (this.options.bytesPerSecond > 0)
      limits.push({
        rate: this.options.bytesPerSecond,
        schedule: new BandwidthSchedule(this.clock),
      })
    const budgets =
      typeof bandwidth === 'number'
        ? [{ key: actor, rate: bandwidth }]
        : (bandwidth ?? [])
    const sharedBudgets: { active: number }[] = []
    for (const budget of budgets) {
      if (budget.rate === 0) continue
      let shared = this.actorBandwidth.get(budget.key)
      if (!shared) {
        shared = { schedule: new BandwidthSchedule(this.clock), active: 0 }
        this.actorBandwidth.set(budget.key, shared)
      }
      shared.active++
      sharedBudgets.push(shared)
      limits.push({ rate: budget.rate, schedule: shared.schedule })
    }
    const activity = new Activity(
      kind,
      actor,
      total,
      termination ? AbortSignal.any([req.signal, termination]) : req.signal,
      limits,
      () => {
        if (this.jobs.delete(activity.id)) {
          for (const budget of sharedBudgets) budget.active--
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
    this.actorBandwidth.clear()
  }
  cancel(id: string, operationOwner?: string) {
    const job = this.jobs.get(id)
    if (
      !job ||
      (operationOwner !== undefined &&
        (job.actor !== operationOwner ||
          (job.kind !== 'copy' && job.kind !== 'move')))
    )
      return false
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

async function* pacedChunks(
  source: AsyncGenerator<Uint8Array>,
  activity: Activity,
) {
  for await (const chunk of source) {
    let offset = 0
    while (offset < chunk.byteLength) {
      const size = activity.quantum(chunk.byteLength - offset)
      yield offset === 0 && size === chunk.byteLength
        ? chunk
        : chunk.subarray(offset, offset + size)
      offset += size
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
  const output = pacedChunks(source, activity)
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
