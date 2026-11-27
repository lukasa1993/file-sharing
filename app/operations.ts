import { AppError, type Guard, type ResourceRef } from './contracts.ts'
import { resource, selected } from './metadata.ts'
import type { CopyProgress, Filesystem } from './filesystem/index.ts'
import type { Transfers } from './transfers/index.ts'

type Progress = (event: CopyProgress & { item: number; items: number }) => void
type Operation = 'copy' | 'move' | 'rename' | 'delete' | 'trash'
export async function fileOperation(
  fs: Filesystem,
  fields: Record<string, unknown>,
  guard: Guard,
  signal?: AbortSignal,
  progress?: Progress,
) {
  const { operation, conflict = 'reject' } = fields
  if (
    conflict !== 'reject' &&
    conflict !== 'skip' &&
    conflict !== 'rename' &&
    conflict !== 'overwrite'
  )
    throw new AppError(400, 'Unknown conflict policy')
  if (operation === 'restore' || operation === 'purge') {
    if (
      !Array.isArray(fields.ids) ||
      !fields.ids.length ||
      fields.ids.length > 256 ||
      fields.ids.some((id) => typeof id !== 'string')
    )
      throw new AppError(400, 'Select valid trash entries')
    const results = []
    for (const id of fields.ids as string[]) {
      try {
        if (operation === 'restore') {
          const result = await fs.restore(id, guard, conflict)
          results.push({ id, ok: true, result, skipped: result === null })
        } else {
          await fs.purgeTrash(id, guard)
          results.push({ id, ok: true })
        }
      } catch (error) {
        if (!(error instanceof AppError)) throw error
        results.push({
          id,
          ok: false,
          error: error.message,
          status: error.status,
        })
      }
    }
    return batchResponse(results)
  }
  if (operation === 'bulkRename') {
    if (!Array.isArray(fields.entries) || fields.entries.length > 256)
      throw new AppError(400, 'Invalid bulk rename selection')
    const entries = fields.entries.map((entry: unknown) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        !('ref' in entry) ||
        !('name' in entry) ||
        typeof entry.name !== 'string'
      )
        throw new AppError(400, 'Each rename needs an item and a new name')
      return { ref: resource(entry.ref), name: entry.name }
    })
    return batchResponse(await fs.bulkRename(entries, guard, conflict, signal))
  }
  const refs = selected(fields.refs)
  const name = fields.name
  if (operation === 'createDir') {
    if (refs.length !== 1 || !refs[0] || typeof name !== 'string')
      throw new AppError(400, 'Choose a parent and folder name')
    await fs.createDir(
      resource({
        mountId: refs[0].mountId,
        segments: [...refs[0].segments, name],
      }),
      guard,
    )
    return Response.json({ ok: true }, { status: 201 })
  }
  if (
    operation !== 'copy' &&
    operation !== 'move' &&
    operation !== 'rename' &&
    operation !== 'delete' &&
    operation !== 'trash'
  )
    throw new AppError(400, 'Unknown file operation')
  const op: Operation = operation
  const parent =
    op === 'copy' || op === 'move' ? resource(fields.destination) : null
  if (op === 'rename' && (refs.length !== 1 || typeof name !== 'string'))
    throw new AppError(400, 'Choose one item to rename')
  const results = []
  for (const ref of refs) {
    try {
      const basename = ref.segments.at(-1)
      if (!basename)
        throw new AppError(400, 'A storage root cannot be moved or removed')
      let dest: ResourceRef | null = null
      if (parent)
        dest = resource({
          mountId: parent.mountId,
          segments: [...parent.segments, basename],
        })
      else if (op === 'rename')
        dest = resource({
          mountId: ref.mountId,
          segments: [...ref.segments.slice(0, -1), name],
        })
      const changed = await fs.operate(
        op,
        ref,
        dest,
        guard,
        conflict,
        signal,
        progress
          ? (event) =>
              progress({
                ...event,
                item: results.length + 1,
                items: refs.length,
              })
          : undefined,
      )
      results.push({ ref, ok: true, result: changed })
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      results.push({
        ref,
        ok: false,
        error: error.message,
        status: error.status,
      })
    }
  }
  return batchResponse(results)
}
function batchResponse(
  results: { ok: boolean; error?: string; status?: number }[],
) {
  const failed = results.filter((r) => !r.ok)
  if (failed.length === results.length)
    return Response.json(
      {
        results,
        error: { message: failed[0]?.error || 'The operation failed' },
      },
      { status: failed[0]?.status ?? 409 },
    )
  return Response.json(
    {
      results,
      ...(failed.length
        ? {
            partial: true,
            message: `${failed.length} items could not be changed`,
          }
        : {}),
    },
    { status: failed.length ? 207 : 200 },
  )
}

export function handleFileOperation(
  fs: Filesystem,
  transfers: Transfers,
  fields: Record<string, unknown>,
  guard: Guard,
  actor: string,
  request: Request,
) {
  if (fields.operation === 'cancel') {
    if (
      typeof fields.id !== 'string' ||
      !transfers.cancelFileOperation(fields.id, actor)
    )
      throw new AppError(404, 'File operation is no longer active')
    return new Response(null, { status: 204 })
  }
  if (
    fields.progress !== true ||
    (fields.operation !== 'copy' && fields.operation !== 'move')
  )
    return fileOperation(fs, fields, guard, request.signal)
  const job = transfers.beginFileOperation(fields.operation, actor, request)
  const encoder = new TextEncoder()
  let detached = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      function send(value: unknown) {
        if (!detached)
          controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'))
      }
      send({ type: 'started', id: job.id })
      let last = -Infinity,
        counted: ResourceRef | undefined,
        offset = 0
      async function work() {
        try {
          const response = await fileOperation(
            fs,
            fields,
            guard,
            job.signal,
            (event) => {
              if (event.phase === 'copying') {
                if (counted !== event.ref) {
                  counted = event.ref
                  offset = 0
                }
                job.bytes += event.bytes - offset
                offset = event.bytes
              }
              const now = performance.now()
              // Drop intermediate snapshots when a reader is slow. Only the terminal
              // result is mandatory, and it is bounded by the selection limit.
              if ((controller.desiredSize ?? 0) > 0 && now - last >= 120) {
                send({ type: 'progress', ...event })
                last = now
              }
            },
          )
          const result = await response.json()
          send({ type: 'result', status: response.status, result })
        } catch (error) {
          send({
            type: 'result',
            status: error instanceof AppError ? error.status : 500,
            result: {
              error: {
                message:
                  error instanceof AppError
                    ? error.message
                    : 'The file operation failed',
              },
            },
          })
        } finally {
          job.remove()
          if (!detached) controller.close()
        }
      }
      work().catch((error) => {
        if (!detached) controller.error(error)
      })
    },
    cancel() {
      detached = true
      job.aborter.abort()
      return job.finished.promise
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
