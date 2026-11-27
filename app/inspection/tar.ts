import type { FileHandle } from 'node:fs/promises'
import { parseTarHeader, TarParseError } from 'remix/tar-parser'

export class UnsupportedInspection extends Error {
  readonly _tag = 'UnsupportedInspection'
}
export type ArchiveItem = {
  name: string
  kind: 'file' | 'directory'
  size: number
}

const blockSize = 512
const maxEntries = 1000
const maxNames = 128 * 1024
const maxArchiveSize = 4 * 1024 ** 4
const maxTrailingPadding = 64 * 1024

async function readAt(
  handle: FileHandle,
  target: Buffer,
  offset: number,
  signal: AbortSignal,
) {
  let filled = 0
  while (filled < target.length) {
    signal.throwIfAborted()
    const { bytesRead } = await handle.read(
      target,
      filled,
      target.length - filled,
      offset + filled,
    )
    if (!bytesRead)
      throw new UnsupportedInspection(
        'The archive ended before its header was complete.',
      )
    filled += bytesRead
  }
}

/** Inspect standard, uncompressed USTAR files by seeking directly to metadata blocks. */
export async function listTarHeaders(
  handle: FileHandle,
  size: number,
  signal: AbortSignal,
): Promise<ArchiveItem[]> {
  if (
    !Number.isSafeInteger(size) ||
    size < 2 * blockSize ||
    size % blockSize ||
    size > maxArchiveSize
  )
    throw new UnsupportedInspection(
      'Archive size is outside the inspection limits.',
    )
  const block = Buffer.alloc(blockSize)
  const entries: ArchiveItem[] = []
  let offset = 0
  let nameBytes = 0
  while (offset + blockSize <= size) {
    await readAt(handle, block, offset, signal)
    if (block.every((b) => b === 0)) {
      const tailSize = size - offset - blockSize
      if (tailSize < blockSize || tailSize > maxTrailingPadding)
        throw new UnsupportedInspection('Unsupported archive terminator.')
      const tail = Buffer.alloc(tailSize)
      await readAt(handle, tail, offset + blockSize, signal)
      if (!tail.every((b) => b === 0))
        throw new UnsupportedInspection('Unexpected data after the archive.')
      return entries
    }
    if (entries.length >= maxEntries)
      throw new UnsupportedInspection('Too many archive entries to preview.')
    let info
    try {
      info = parseTarHeader(block, {
        allowUnknownFormat: false,
        pathPolicy: 'relative',
      })
    } catch (error) {
      if (error instanceof TarParseError)
        throw new UnsupportedInspection('Unsupported archive header.')
      throw error
    }
    if (
      (info.type !== 'file' && info.type !== 'directory') ||
      (info.type === 'directory' && info.size !== 0)
    )
      throw new UnsupportedInspection(
        'Only ordinary file and directory entries can be listed.',
      )
    if (
      /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(info.name) ||
      info.name.length > 1024
    )
      throw new UnsupportedInspection('Unsupported archive filename.')
    nameBytes += Buffer.byteLength(info.name)
    const remaining = size - offset - blockSize
    if (nameBytes > maxNames || info.size > remaining)
      throw new UnsupportedInspection('Invalid archive length.')
    entries.push({ name: info.name, kind: info.type, size: info.size })
    offset += blockSize + Math.ceil(info.size / blockSize) * blockSize
  }
  throw new UnsupportedInspection('Archive terminator missing.')
}
