import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { Clock, Effect } from 'effect'
import { AppError, type Guard, type ResourceRef } from '../contracts.ts'
import { attempt, runTask } from '../effects.ts'
import type { Filesystem } from '../filesystem/index.ts'
import { Downloads, type DownloadOptions } from './downloads.ts'
import { Uploads, type UploadAccess } from './uploads.ts'
import {
  ActivityRegistry,
  type TransferOptions,
  type PreparationTimeouts,
} from './streams.ts'
import { TEXT_LIMIT, textExtensions } from './preview.ts'

export type { DownloadOptions, UploadAccess, TransferOptions }

export class Transfers {
  private readonly timeouts: PreparationTimeouts = new WeakMap()
  private readonly jobs: ActivityRegistry
  private readonly downloads: Downloads
  private readonly uploads: Uploads
  constructor(
    db: Database,
    private readonly fs: Filesystem,
    options: TransferOptions = {},
    clock: Clock.Clock = Clock.Clock.defaultValue(),
  ) {
    for (const [name, value] of Object.entries(options)) {
      if (
        !Number.isSafeInteger(value) ||
        value < (name === 'bytesPerSecond' ? 0 : 1)
      )
        throw new Error('Invalid transfer option: ' + name)
    }
    this.jobs = new ActivityRegistry(options)
    this.downloads = new Downloads(fs, this.jobs, this.timeouts)
    this.uploads = new Uploads(db, fs, this.jobs, options, clock, this.timeouts)
  }

  setPreparationTimeout(
    request: Request,
    switchTimeout: (preparing: boolean) => void,
  ) {
    this.timeouts.set(request, switchTimeout)
  }
  downloadTask(
    req: Request,
    ref: ResourceRef,
    guard: Guard,
    options: DownloadOptions = {},
  ) {
    return attempt(() => this.downloads.file(req, ref, guard, options, false))
  }
  download(
    req: Request,
    ref: ResourceRef,
    guard: Guard,
    options: DownloadOptions = {},
  ) {
    return runTask(this.downloadTask(req, ref, guard, options))
  }
  preview(
    req: Request,
    ref: ResourceRef,
    guard: Guard,
    options: DownloadOptions = {},
  ) {
    return runTask(
      attempt(() => this.downloads.file(req, ref, guard, options, true)),
    )
  }
  archive(
    req: Request,
    refs: ResourceRef[],
    guard: Guard,
    options: DownloadOptions = {},
  ) {
    return runTask(
      attempt(() => this.downloads.archive(req, refs, guard, options)),
    )
  }
  uploadTask(req: Request, access: UploadAccess, id?: string) {
    return attempt(() => this.uploads.handle(req, access, id))
  }
  upload(req: Request, access: UploadAccess, id?: string) {
    return runTask(this.uploadTask(req, access, id))
  }

  active() {
    return this.jobs.list()
  }
  cancel(id: string) {
    return this.jobs.cancel(id)
  }
  cleanup() {
    return runTask(attempt(() => this.uploads.cleanup()))
  }
  shutdown() {
    return runTask(attempt(() => this.jobs.shutdown()))
  }

  async editText(req: Request, ref: ResourceRef, guard: Guard) {
    if (req.method !== 'PUT') throw new AppError(405, 'Use PUT to save text.')
    if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'text/plain')
      throw new AppError(415, 'Expected a text document.')
    guard('read', ref)
    guard('modify', ref)
    if (!textExtensions.has(extname(ref.segments.at(-1) ?? '').toLowerCase()))
      throw new AppError(415, 'This format cannot be edited as text.')
    const version = req.headers.get('if-match')?.match(/^"([^"]+)"$/)?.[1]
    if (!version)
      throw new AppError(428, 'Reopen this document before editing.')
    const current = await this.fs.stat(ref, guard, 'modify')
    if (current.version !== version)
      throw new AppError(
        412,
        'This document changed. Reopen it before editing.',
      )
    if (current.size > TEXT_LIMIT)
      throw new AppError(413, 'Open this document in a local editor.')
    const id = randomUUID()
    // Staging an edit reuses the upload publisher, but an editor needs only
    // read and modify on this existing file. No directory may be created.
    const editGuard: Guard = Object.assign(
      (action: Parameters<Guard>[0], candidate: ResourceRef) => {
        if (
          candidate.mountId !== ref.mountId ||
          candidate.segments.length !== ref.segments.length ||
          !candidate.segments.every((part, i) => part === ref.segments[i]) ||
          !['upload', 'modify'].includes(action)
        )
          throw new AppError(403, 'Cannot change the document destination.')
        guard('modify', ref)
      },
      guard,
    )
    const work = Effect.acquireUseRelease(
      attempt(() => this.fs.createStage(ref, id, editGuard)),
      (handle) =>
        attempt(async () => {
          const reader = req.body?.getReader()
          const chunks: Uint8Array[] = []
          let length = 0
          try {
            while (reader) {
              req.signal.throwIfAborted()
              const item = await reader.read()
              if (item.done) break
              length += item.value.byteLength
              if (length > TEXT_LIMIT)
                throw new AppError(413, 'The document exceeds the text limit.')
              chunks.push(item.value)
            }
            const data = Buffer.concat(chunks, length)
            try {
              new TextDecoder('utf-8', { fatal: true }).decode(data)
            } catch {
              throw new AppError(422, 'Expected UTF-8 text.')
            }
            if (data.includes(0))
              throw new AppError(422, 'Expected UTF-8 text.')
            await handle.writeFile(data)
            await handle.sync()
            req.signal.throwIfAborted()
            await this.fs.commitStage(
              ref,
              id,
              editGuard,
              'overwrite',
              () => guard('modify', ref),
              version,
            )
          } finally {
            if (reader) {
              await reader.cancel().catch(() => {})
              reader.releaseLock()
            }
          }
        }),
      (handle) =>
        attempt(async () => {
          try {
            await handle.close()
          } finally {
            await this.fs.discardStage(ref.mountId, id)
          }
        }),
    )
    await runTask(work)
    return new Response(null, { status: 204 })
  }
}
