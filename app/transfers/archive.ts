import { posix } from 'node:path'
import { Readable } from 'node:stream'
import { createGzip } from 'node:zlib'
import type { Filesystem } from '../filesystem/index.ts'
import {
  AppError,
  type Entry,
  type Guard,
  type ResourceRef,
} from '../contracts.ts'
import { chunks } from './streams.ts'

const blockSize = 512
const zero = Buffer.alloc(blockSize)
const largestOctalSize = 8 ** 11 - 1

function header(name: string, size: number, mtime: number, type: string) {
  const buffer = Buffer.alloc(blockSize)
  buffer.write(name, 0, 100, 'ascii')
  const octal = (offset: number, width: number, value: number) => {
    buffer.write(
      value.toString(8).padStart(width - 1, '0') + '\0',
      offset,
      width,
      'ascii',
    )
  }
  octal(100, 8, type === '5' ? 0o755 : 0o644)
  octal(108, 8, 0)
  octal(116, 8, 0)
  octal(124, 12, size)
  octal(136, 12, Math.max(0, Math.min(largestOctalSize, mtime)))
  buffer.fill(32, 148, 156)
  buffer.write(type, 156, 1)
  buffer.write('ustar\0', 257)
  buffer.write('00', 263)
  buffer.write(
    buffer
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
  )
  return buffer
}

function pax(key: string, value: string) {
  const record = ' ' + key + '=' + value + '\n'
  const bytes = Buffer.byteLength(record)
  let length = bytes + 1
  while (length !== bytes + String(length).length)
    length = bytes + String(length).length
  return String(length) + record
}

function* headers(path: string, entry: Entry) {
  const size = entry.kind === 'file' ? entry.size : 0
  const mtime = Math.floor(Date.parse(entry.modifiedAt) / 1000) || 0
  let extended = ''
  const short = /^[\x20-\x7e]{1,100}$/.test(path)
  if (!short) extended += pax('path', path)
  if (size > largestOctalSize) extended += pax('size', String(size))
  if (extended) {
    const data = Buffer.from(extended)
    yield header('PaxHeader', data.length, mtime, 'x')
    yield data
    if (data.length % blockSize) yield zero.subarray(data.length % blockSize)
  }
  yield header(
    short ? path : 'entry',
    size > largestOctalSize ? 0 : size,
    mtime,
    entry.kind === 'directory' ? '5' : '0',
  )
}

function safeName(name: string) {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[/\\\x00-\x1f\x7f]/.test(name) ||
    /^[a-z]:/i.test(name)
  ) {
    throw new AppError(
      422,
      'An entry has a name that cannot be exported safely.',
    )
  }
  return name
}

export async function* tarStream(
  fs: Filesystem,
  roots: Entry[],
  guard: Guard,
  signal: AbortSignal,
  validate?: (entry: Entry) => void,
): AsyncGenerator<Uint8Array> {
  let count = 0
  async function* walk(
    entry: Entry,
    name: string,
    depth: number,
  ): AsyncGenerator<Uint8Array> {
    signal.throwIfAborted()
    if (++count > 100_000 || depth > 128)
      throw new AppError(413, 'The archive selection is too large.')
    if (entry.kind === 'directory') {
      const current = await fs.stat(entry.ref, guard, 'list')
      validate?.(current)
      if (current.kind !== 'directory')
        throw new AppError(409, 'The directory changed.')
      const children = await fs.list(entry.ref, guard)
      yield* headers(name, current)
      for (const child of children)
        yield* walk(child, posix.join(name, safeName(child.name)), depth + 1)
      return
    }
    const opened = await fs.openRead(entry.ref, guard)
    try {
      validate?.(opened.entry)
      yield* headers(name, opened.entry)
      yield* chunks(opened.handle, 0, opened.entry.size, signal)
      const rem = opened.entry.size % blockSize
      if (rem) yield zero.subarray(rem)
    } finally {
      await opened.handle.close()
    }
  }
  const used = new Set<string>()
  for (const entry of roots) {
    const original = safeName(entry.name || 'files')
    let name = original
    for (let suffix = 2; used.has(name); suffix++)
      name = original + '-' + suffix
    used.add(name)
    yield* walk(entry, name, 0)
  }
  yield zero
  yield zero
}

/** Discover kind without requiring directory listing permission for an individual file. */
export async function archiveRoots(
  fs: Filesystem,
  refs: ResourceRef[],
  guard: Guard,
  validate?: (entry: Entry) => void,
) {
  if (!refs.length || refs.length > 512)
    throw new AppError(400, 'Select between one and 512 entries.')
  const result: Entry[] = []
  for (const ref of refs) {
    let entry: Entry
    try {
      entry = await fs.stat(ref, guard, 'read')
    } catch (error) {
      if (!(error instanceof AppError) || ![403, 404].includes(error.status))
        throw error
      entry = await fs.stat(ref, guard, 'list')
    }
    guard(entry.kind === 'directory' ? 'list' : 'read', ref)
    validate?.(entry)
    result.push(entry)
  }
  return result
}

export async function* gzipArchive(
  source: AsyncGenerator<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const input = Readable.from(source, {
    objectMode: false,
    highWaterMark: 128 * 1024,
  })
  const compressed = input.compose(createGzip(), { signal })
  try {
    for await (const chunk of compressed) {
      signal.throwIfAborted()
      yield chunk as Uint8Array
    }
  } finally {
    compressed.destroy()
    input.destroy()
    await source.return(undefined)
  }
}
