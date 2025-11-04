import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const RESUMABLE_META_NAME = 'meta.json'
export const RESUMABLE_DATA_NAME = 'data.bin'

export type ContentRange = {
  start: number
  end: number
  total: number
}

export type ResumableMeta = {
  name: string
  type: string
  size: number
  relativePath: string
  lastModified: number
  completed?: boolean
}

export function parseContentRange(header: string | null): ContentRange | null {
  if (!header) {
    return null
  }
  let match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header.trim())
  if (!match) {
    return null
  }
  let start = Number.parseInt(match[1], 10)
  let end = Number.parseInt(match[2], 10)
  let total = Number.parseInt(match[3], 10)
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(total)) {
    return null
  }
  if (start < 0 || end < start || total <= 0) {
    return null
  }
  return { start, end, total }
}

export function sanitizeSegment(value: string | null) {
  if (!value) return ''
  let cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, '')
  if (cleaned.length === 0) {
    return ''
  }
  return cleaned.slice(0, 120)
}

export function decodeUploadHeader(value: string | null) {
  if (!value) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export async function prepareResumableSlot({
  root,
  scope,
  uploadId,
}: {
  root: string
  scope: string
  uploadId: string
}) {
  let safeScope = sanitizeSegment(scope) || 'scope'
  let safeId = sanitizeSegment(uploadId) || 'upload'
  let directory = join(root, safeScope, safeId)
  await mkdir(directory, { recursive: true })
  return {
    directory,
    dataPath: join(directory, RESUMABLE_DATA_NAME),
    metaPath: join(directory, RESUMABLE_META_NAME),
  }
}

export async function readResumableMeta(pathname: string): Promise<ResumableMeta | null> {
  let file = Bun.file(pathname)
  if (!(await file.exists())) {
    return null
  }

  let content = await file.text()
  let parsed = JSON.parse(content)
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  let metadata = parsed as Partial<ResumableMeta>
  if (typeof metadata.name !== 'string' || typeof metadata.size !== 'number') {
    return null
  }
  return {
    name: metadata.name,
    type: typeof metadata.type === 'string' ? metadata.type : 'application/octet-stream',
    size: metadata.size,
    relativePath: typeof metadata.relativePath === 'string' ? metadata.relativePath : '',
    lastModified: typeof metadata.lastModified === 'number' ? metadata.lastModified : Date.now(),
    completed: metadata.completed ?? false,
  }
}

export async function writeResumableMeta(pathname: string, meta: ResumableMeta) {
  let directory = dirname(pathname)
  await mkdir(directory, { recursive: true })
  let serialized = JSON.stringify(meta)
  await bunWrite(pathname, serialized)
}

export async function writeResumableChunk(pathname: string, chunk: Uint8Array, offset: number) {
  let file = Bun.file(pathname)
  let exists = await file.exists()
  let size = exists ? file.size : 0

  if (!exists && offset !== 0) {
    throw new Error('Unexpected chunk offset.')
  }

  if (offset > size) {
    throw new Error('Unexpected chunk offset.')
  }

  if (offset < size) {
    let overlap = size - offset
    if (overlap >= chunk.length) {
      return size
    }

    let remainder = chunk.subarray(overlap)
    await bunWrite(pathname, remainder, { append: true })
    return size + remainder.length
  }

  await bunWrite(pathname, chunk, { append: offset > 0 })
  return offset + chunk.length
}

export async function cleanupResumableSlot(directory: string) {
  try {
    await rm(directory, { recursive: true, force: true })
  } catch (error) {
    if (!isNoEntryError(error)) {
      throw error
    }
  }
}

export async function getFileSize(pathname: string): Promise<number | null> {
  let file = Bun.file(pathname)
  if (!(await file.exists())) {
    return null
  }
  return file.size
}

export function isNoEntryError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error) && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function bunWrite(pathname: string, data: string | Uint8Array, options?: { append?: boolean }) {
  let payload = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return (Bun.write as unknown as (path: string, chunk: Uint8Array, opts?: { append?: boolean }) => Promise<number>)(
    pathname,
    payload,
    options,
  )
}
