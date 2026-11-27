import { extname } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { listTarHeaders, UnsupportedInspection } from '../inspection/tar.ts'
import { AppError, type Entry } from '../contracts.ts'
import { readBounded } from './streams.ts'

export const TEXT_LIMIT = 256 * 1024
export const textExtensions = new Set([
  '.txt',
  '.md',
  '.log',
  '.csv',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ts',
  '.css',
  '.py',
  '.go',
  '.rs',
  '.sql',
])
const imageExtensions = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.avif',
  '.heic',
])

function rasterSignature(ext: string, bytes: Buffer) {
  const ascii = (start: number, end: number) =>
    bytes.toString('latin1', start, end)
  switch (ext) {
    case '.png':
      return ascii(0, 8) === '\x89PNG\r\n\x1a\n'
    case '.jpg':
    case '.jpeg':
      return ascii(0, 3) === '\xff\xd8\xff'
    case '.webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
    case '.gif':
      return ['GIF87a', 'GIF89a'].includes(ascii(0, 6))
    case '.bmp':
      return ascii(0, 2) === 'BM'
    case '.avif':
      return ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))
    case '.heic':
      return (
        ascii(4, 8) === 'ftyp' &&
        ['heic', 'heix', 'hevc', 'hevx'].includes(ascii(8, 12))
      )
    default:
      return false
  }
}

export type Preview = { type: string; bytes?: Buffer; size?: number }
function mediaMime(ext: string, header: Buffer) {
  const ascii = (start: number, end: number) =>
    header.toString('ascii', start, end)
  if (ext === '.wav' && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE')
    return 'audio/wav'
  if (ext === '.flac' && ascii(0, 4) === 'fLaC') return 'audio/flac'
  if (
    ['.ogg', '.opus', '.ogv'].includes(ext) &&
    ascii(0, 4) === 'OggS' &&
    header[4] === 0
  )
    return ext === '.ogv' ? 'video/ogg' : 'audio/ogg'
  if (
    ext === '.mp3' &&
    (ascii(0, 3) === 'ID3' ||
      (header[0] === 255 && ((header[1] ?? 0) & 0xe0) === 0xe0))
  )
    return 'audio/mpeg'
  if (
    ['.mp4', '.m4v', '.m4a'].includes(ext) &&
    ascii(4, 8) === 'ftyp' &&
    /^(isom|iso[2-9]|mp4[12]|avc1|M4[AV] )$/.test(ascii(8, 12))
  )
    return ext === '.m4a' ? 'audio/mp4' : 'video/mp4'
  if (
    ext === '.webm' &&
    header.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) &&
    header.includes('webm')
  )
    return 'video/webm'
  return null
}

export class Previews {
  private thumbnails = new Map<string, Buffer>()
  private cacheBytes = 0
  private decoding = 0

  async representation(
    handle: FileHandle,
    entry: Entry,
    thumbnail: boolean,
    signal: AbortSignal,
  ): Promise<Preview | null> {
    const ext = extname(entry.name).toLowerCase()
    if (textExtensions.has(ext)) {
      const bytes = await readBounded(handle, Math.min(entry.size, TEXT_LIMIT))
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, {
          stream: bytes.length < entry.size,
        })
        if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) return null
        return { type: 'text/plain', bytes: Buffer.from(text) }
      } catch {
        return null
      }
    }
    if (ext === '.tar') {
      try {
        const entries = await listTarHeaders(handle, entry.size, signal)
        const listing = entries.map(
          (item) =>
            item.name +
            (item.kind === 'directory' ? '/' : '  ' + item.size + ' bytes'),
        )
        return { type: 'text/plain', bytes: Buffer.from(listing.join('\n')) }
      } catch (error) {
        if (error instanceof UnsupportedInspection) return null
        throw error
      }
    }
    if (imageExtensions.has(ext) && entry.size <= 16 * 1024 * 1024) {
      const key = entry.ref.mountId + ':' + entry.version
      const cached = thumbnail && this.thumbnails.get(key)
      if (cached) return { type: 'image/webp', bytes: cached }
      if (this.decoding >= 2)
        throw new AppError(429, 'Preview workers are busy.')
      this.decoding++
      try {
        const bytes = await readBounded(handle, entry.size)
        if (!rasterSignature(ext, bytes)) return null
        const pipeline = new Bun.Image(bytes, { maxPixels: 16_000_000 })
        const meta = await pipeline.metadata()
        const maximum = thumbnail ? 256 : 2048
        const width = Math.min(meta.width, maximum)
        const height = Math.min(meta.height, maximum)
        signal.throwIfAborted()
        const encoded = Buffer.from(
          await pipeline
            .resize(width, height, { fit: 'inside' })
            .webp({ quality: 80 })
            .bytes(),
        )
        if (encoded.length > (thumbnail ? 256 * 1024 : 8 * 1024 * 1024))
          return null
        if (thumbnail) {
          while (
            this.cacheBytes + encoded.length > 8 * 1024 * 1024 ||
            this.thumbnails.size >= 256
          ) {
            const first = this.thumbnails.entries().next().value
            if (!first) break
            this.cacheBytes -= first[1].length
            this.thumbnails.delete(first[0])
          }
          const previous = this.thumbnails.get(key)
          if (previous) this.cacheBytes -= previous.length
          this.thumbnails.set(key, encoded)
          this.cacheBytes += encoded.length
        }
        return { type: 'image/webp', bytes: encoded }
      } catch {
        signal.throwIfAborted()
        return null
      } finally {
        this.decoding--
      }
    }
    const type = mediaMime(
      ext,
      await readBounded(handle, Math.min(entry.size, 128)),
    )
    return type ? { type } : null
  }
}
