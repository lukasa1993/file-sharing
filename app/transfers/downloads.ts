import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { Exit, Scope } from 'effect'
import { runTask } from '../effects.ts'
import type { FileHandle } from 'node:fs/promises'
import { ContentDisposition } from 'remix/headers'
import { createFileResponse } from 'remix/response/file'
import { detectMimeType } from 'remix/mime'
import {
  AppError,
  type Entry,
  type Guard,
  type ResourceRef,
} from '../contracts.ts'
import { version as statVersion } from '../filesystem/resolver.ts'
import type { Filesystem } from '../filesystem/index.ts'
import {
  ActivityRegistry,
  bodyStream,
  chunks,
  preparationDigest,
  type PreparationTimeouts,
} from './streams.ts'
import { archiveRoots, gzipArchive, tarStream } from './archive.ts'
import { Previews, TEXT_LIMIT, textExtensions } from './preview.ts'

export type DownloadOptions = {
  actor?: string
  onStart?: (etag: string) => void
  onBytes?: (count: number) => void
  bytesPerSecond?: number
  validateEntry?: (entry: Entry) => void
}

function disposition(name: string, inline: boolean) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%;]/g, '_')
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase(),
  )
  return new ContentDisposition({
    type: inline ? 'inline' : 'attachment',
    filename: ascii,
    filenameSplat: "UTF-8''" + encoded,
  }).toString()
}

async function* single(bytes: Buffer) {
  if (bytes.length) yield bytes
}

export class Downloads {
  private hashes = new Map<string, string>()
  private previews = new Previews()
  constructor(
    readonly fs: Filesystem,
    readonly jobs: ActivityRegistry,
    private readonly timeouts: PreparationTimeouts = new WeakMap(),
  ) {}

  private async stableDigest(
    request: Request,
    handle: FileHandle,
    mount: string,
    size: number,
    signal: AbortSignal,
  ) {
    const before = await handle.stat({ bigint: true })
    if (before.size !== BigInt(size))
      throw new AppError(409, 'The file changed. Please reopen it.')
    const version = statVersion(before)
    const key = mount + ':' + version
    const cached = this.hashes.get(key)
    if (cached) return cached
    const value = await preparationDigest(
      request,
      this.timeouts,
      handle,
      size,
      signal,
    )
    if (version !== statVersion(await handle.stat({ bigint: true })))
      throw new AppError(409, 'The file changed while preparing the transfer.')
    if (this.hashes.size >= 512) {
      const oldest = this.hashes.keys().next().value
      if (oldest !== undefined) this.hashes.delete(oldest)
    }
    this.hashes.set(key, value)
    return value
  }

  async file(
    req: Request,
    ref: ResourceRef,
    guard: Guard,
    options: DownloadOptions,
    preview: boolean,
  ) {
    if (req.method !== 'HEAD' && req.method !== 'GET')
      throw new AppError(405, 'Use GET or HEAD.')
    const scope = Scope.makeUnsafe()
    const { handle, entry } = await runTask(
      Scope.provide(scope)(this.fs.openReadScoped(ref, guard)),
    )
    const release = () => runTask(Scope.close(scope, Exit.void))
    let job: ReturnType<ActivityRegistry['start']> | undefined
    let stream: ReadableStream<Uint8Array> | undefined
    let ownsHandle = true
    try {
      options.validateEntry?.(entry)
      const activity = (job = this.jobs.start(
        'download',
        options.actor ?? 'anonymous',
        entry.size,
        req,
        options.bytesPerSecond,
      ))
      const representation = preview
        ? await this.previews.representation(
            handle,
            entry,
            new URL(req.url).searchParams.get('thumbnail') === '1',
            activity.signal,
          )
        : null
      const memory = representation?.bytes
      const size = memory?.length ?? entry.size
      const sha = memory
        ? createHash('sha256').update(memory).digest('hex')
        : await this.stableDigest(
            req,
            handle,
            ref.mountId,
            size,
            activity.signal,
          )
      activity.signal.throwIfAborted()
      guard('read', ref)
      options.validateEntry?.(entry)
      const rangeStream = (start: number, end: number) => {
        stream = bodyStream(
          memory
            ? single(memory.subarray(start, end))
            : chunks(handle, start, end, activity.signal),
          activity,
          release,
          options.onBytes,
        )
        return stream
      }
      const file: Parameters<typeof createFileResponse>[0] = {
        name: entry.name,
        size,
        lastModified: Date.parse(entry.modifiedAt),
        type:
          representation?.type ??
          detectMimeType(extname(entry.name)) ??
          'application/octet-stream',
        stream: () => rangeStream(0, size),
        slice: (start = 0, end = size) => ({
          stream: () => rangeStream(start, end),
        }),
        arrayBuffer: async () => {
          throw new Error('A transfer requires streaming reads.')
        },
      }
      const headers = new Headers(req.headers)
      // Host files can change more than once per second, so Last-Modified
      // cannot provide the strong validator RFC 9110 requires for If-Range.
      const ifRange = headers.get('if-range')
      if (
        req.method === 'HEAD' ||
        headers.get('range')?.includes(',') ||
        (ifRange !== null && !ifRange.startsWith('"'))
      )
        headers.delete('range')
      const response = await createFileResponse(
        file,
        new Request(req.url, { method: req.method, headers }),
        {
          acceptRanges: true,
          etag: 'strong',
          digest: async () => sha,
          cacheControl: 'private, no-store, no-transform',
        },
      )
      response.headers.set('Cache-Control', 'private, no-store, no-transform')
      response.headers.set('X-Content-Type-Options', 'nosniff')
      response.headers.set('Referrer-Policy', 'no-referrer')
      response.headers.set(
        'Content-Security-Policy',
        "sandbox; default-src 'none'; frame-ancestors 'self'",
      )
      if (response.ok) {
        response.headers.set(
          'Content-Disposition',
          disposition(entry.name, Boolean(representation)),
        )
        if (preview && representation?.type === 'text/plain') {
          response.headers.set('X-File-Version', entry.version)
          if (
            textExtensions.has(extname(entry.name).toLowerCase()) &&
            entry.size > TEXT_LIMIT
          )
            response.headers.set('X-Preview-Truncated', 'true')
        }
        if (stream) options.onStart?.('"' + sha + '"')
      }
      if (stream) {
        ownsHandle = false
        if (!size) {
          await stream.cancel()
          return new Response(null, {
            status: response.status,
            headers: response.headers,
          })
        }
      }
      if (req.method === 'HEAD' && response.body)
        return new Response(null, {
          status: response.status,
          headers: response.headers,
        })
      return response
    } catch (error) {
      if (stream) {
        ownsHandle = false
        await stream.cancel().catch(() => {})
      }
      throw error
    } finally {
      if (ownsHandle) {
        try {
          await release()
        } finally {
          job?.remove()
        }
      }
    }
  }

  async archive(
    req: Request,
    refs: ResourceRef[],
    guard: Guard,
    options: DownloadOptions,
  ) {
    if (req.method !== 'HEAD' && req.method !== 'GET')
      throw new AppError(405, 'Use GET or HEAD.')
    const roots = await archiveRoots(
      this.fs,
      refs,
      guard,
      options.validateEntry,
    )
    const format = new URL(req.url).searchParams.get('format') ?? 'tar'
    if (format !== 'tar' && format !== 'tar.gz')
      throw new AppError(406, 'Supported archive formats are TAR and TAR.GZ.')
    const compressed = format === 'tar.gz'
    const headers = {
      'Content-Type': compressed ? 'application/gzip' : 'application/x-tar',
      'Content-Disposition': disposition(
        compressed ? 'shared-files.tar.gz' : 'shared-files.tar',
        false,
      ),
      'Cache-Control': 'private, no-store, no-transform',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'none',
    }
    if (req.method === 'HEAD') return new Response(null, { headers })
    const job = this.jobs.start(
      'archive',
      options.actor ?? 'anonymous',
      null,
      req,
      options.bytesPerSecond,
    )
    try {
      // An archive stream has no stable range validator. This value only identifies the selection to usage accounting.
      const key = createHash('sha256')
        .update(
          JSON.stringify(roots.map((entry) => [entry.ref, entry.version])),
        )
        .digest('hex')
      options.onStart?.(key)
      const source = tarStream(
        this.fs,
        roots,
        guard,
        job.signal,
        options.validateEntry,
      )
      return new Response(
        bodyStream(
          compressed ? gzipArchive(source, job.signal) : source,
          job,
          async () => {},
          options.onBytes,
        ),
        { headers },
      )
    } catch (error) {
      job.remove()
      throw error
    }
  }
}
