import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

import { ZipFile } from 'yazl'

import { findShare, revokeShareToken, type DownloadShare } from '../../models/share.server.ts'
import { getStoredFile } from '../../utils/uploads.ts'
import { buildDownloadUrl } from '../../utils/share-links.ts'
import { attachmentDisposition } from '../../utils/content-disposition.ts'
import { DownloadSharePage } from '../../components/share/DownloadSharePage.tsx'
import { render } from '../../utils/render.ts'
import { shareUnavailable } from './responses.tsx'

type DownloadShareParams = {
  token: string
  request: Request
}

type DownloadShareFile = {
  key: string
  name: string
  size: number
  type?: string
  downloadUrl: string
  lastModified: number
}

const zipTextEncoder = new TextEncoder()

export async function handleDownloadShare({ token, request }: DownloadShareParams) {
  let share = findShare(token)

  if (!share || share.kind !== 'download') {
    return shareUnavailable('Download share not found or expired.')
  }

  let url = new URL(request.url)
  let key = url.searchParams.get('file')
  let folder = url.searchParams.get('folder')
  let hasFolder = url.searchParams.has('folder')

  if (key) {
    return respondWithFileDownload({ key, share, request })
  }

  if (hasFolder) {
    return respondWithFolderArchive({ share, folder: folder ?? '', request, token })
  }

  let files = await collectSharedFiles(share, url)

  if (files.length === 0) {
    await revokeShareToken(token)
    return shareUnavailable('All shared files were removed.')
  }

  return render(<DownloadSharePage share={share} files={files} />)
}

async function respondWithFileDownload({
  key,
  share,
  request,
}: {
  key: string
  share: DownloadShare
  request: Request
}) {
  if (!share.fileKeys.includes(key)) {
    return new Response('File not found', { status: 404 })
  }

  let file = await getStoredFile(key)
  if (!file) {
    removeMissingFileFromShare(share, key)
    return new Response('File not found', { status: 404 })
  }

  let rangeHeader = request.headers.get('range')
  let baseHeaders = buildBaseDownloadHeaders(file)
  baseHeaders.set('Content-Length', file.size.toString())
  let method = request.method.toUpperCase()

  if (method === 'HEAD') {
    return new Response(null, { headers: baseHeaders })
  }

  if (rangeHeader) {
    let range = parseRangeHeader(rangeHeader, file.size)
    if (!range) {
      baseHeaders.set('Content-Range', `bytes */${file.size}`)
      baseHeaders.set('Content-Length', '0')
      return new Response('Requested range not satisfiable', {
        status: 416,
        headers: baseHeaders,
      })
    }

    let { start, end } = range
    let length = end - start + 1
    baseHeaders.set('Content-Range', `bytes ${start}-${end}/${file.size}`)
    baseHeaders.set('Content-Length', length.toString())

    let chunk = file.slice(start, end + 1)
    return new Response(chunk.stream(), {
      status: 206,
      headers: baseHeaders,
    })
  }

  return new Response(file.stream(), {
    headers: baseHeaders,
  })
}

async function collectSharedFiles(share: DownloadShare, baseUrl: URL) {
  let files: DownloadShareFile[] = []

  for (let fileKey of share.fileKeys) {
    let file = await getStoredFile(fileKey)
    if (!file) {
      removeMissingFileFromShare(share, fileKey)
      continue
    }

    files.push({
      key: fileKey,
      name: file.name,
      size: file.size,
      type: file.type ?? undefined,
      downloadUrl: buildDownloadUrl(baseUrl, share, fileKey),
      lastModified: file.lastModified,
    })
  }

  return files
}

async function respondWithFolderArchive({
  share,
  folder,
  request,
  token,
}: {
  share: DownloadShare
  folder: string
  request: Request
  token: string
}) {
  let normalized = normalizeFolderPath(folder)
  let matchingKeys = collectKeysForFolder(share.fileKeys, normalized)

  if (matchingKeys.length === 0) {
    return shareUnavailable('Folder not found or contains no files.')
  }

  let rawRootName = normalized
    ? (normalized.split('/').at(-1) ?? normalized)
    : `share-${token.slice(0, 8)}`
  let archiveRootName = sanitizeArchivePath(rawRootName) || `share-${token.slice(0, 8)}`
  let directoryPaths = new Set<string>([''])
  let fileEntries: ZipArchiveEntry[] = []

  for (let key of matchingKeys) {
    let file = await getStoredFile(key)
    if (!file) {
      removeMissingFileFromShare(share, key)
      continue
    }

    let relativePath = resolveRelativePath({ key, normalized, fallback: file.name })
    let archivePath = buildZipFilePath(archiveRootName, relativePath)

    fileEntries.push({
      kind: 'file',
      name: archivePath,
      nameBytes: zipTextEncoder.encode(archivePath),
      size: file.size,
      mtime: normalizeTimestamp(file.lastModified),
      file,
    })

    let segments = relativePath.split('/').slice(0, -1)
    let current = ''
    for (let segment of segments) {
      current = current ? `${current}/${segment}` : segment
      directoryPaths.add(current)
    }
  }

  if (fileEntries.length === 0) {
    await revokeShareToken(token)
    return shareUnavailable('All shared files were removed.')
  }

  let directories = Array.from(directoryPaths)
    .sort((a, b) => a.localeCompare(b))
    .map<ZipArchiveEntry>((pathSegment) => {
      let archivePath = buildZipDirectoryPath(archiveRootName, pathSegment)
      return {
        kind: 'directory',
        name: archivePath,
        nameBytes: zipTextEncoder.encode(archivePath),
        size: 0,
        mtime: Date.now(),
      }
    })

  let entries = [...directories, ...fileEntries.sort((a, b) => a.name.localeCompare(b.name))]
  let totalSize = calculateZipSize(entries)
  let baseHeaders = buildArchiveHeaders(`${archiveRootName}.zip`)
  baseHeaders.set('ETag', buildFolderEtag(token, normalized, totalSize))

  let rangeHeader = request.headers.get('range')
  let range = rangeHeader ? parseRangeHeader(rangeHeader, totalSize) : null

  if (rangeHeader && !range) {
    let errorHeaders = new Headers(baseHeaders)
    errorHeaders.set('Content-Range', `bytes */${totalSize}`)
    errorHeaders.set('Content-Length', '0')
    return new Response('Requested range not satisfiable', {
      status: 416,
      headers: errorHeaders,
    })
  }

  let method = request.method.toUpperCase()
  if (method === 'HEAD') {
    let headHeaders = new Headers(baseHeaders)
    headHeaders.set('Content-Length', totalSize.toString())
    return new Response(null, { headers: headHeaders })
  }

  if (range) {
    let { start, end } = range
    let contentLength = end - start + 1
    let rangeHeaders = new Headers(baseHeaders)
    rangeHeaders.set('Content-Length', contentLength.toString())
    rangeHeaders.set('Content-Range', `bytes ${start}-${end}/${totalSize}`)
    let stream = createZipStream(entries, { range })
    return new Response(stream, {
      status: 206,
      headers: rangeHeaders,
    })
  }

  let responseHeaders = new Headers(baseHeaders)
  responseHeaders.set('Content-Length', totalSize.toString())
  let stream = createZipStream(entries)
  return new Response(stream, {
    headers: responseHeaders,
  })
}

function removeMissingFileFromShare(share: DownloadShare, key: string) {
  let index = share.fileKeys.indexOf(key)
  if (index >= 0) {
    share.fileKeys.splice(index, 1)
  }
}

function buildBaseDownloadHeaders(file: File) {
  let headers = new Headers()
  let lastModified = Number.isFinite(file.lastModified) ? file.lastModified : Date.now()

  headers.set('Content-Type', file.type || 'application/octet-stream')
  headers.set('Content-Disposition', attachmentDisposition(file.name))
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Last-Modified', new Date(lastModified).toUTCString())
  headers.set('Cache-Control', 'private, max-age=0, must-revalidate')
  headers.set('ETag', buildWeakEtag(file))

  return headers
}

type ByteRange = {
  start: number
  end: number
}

function parseRangeHeader(header: string, size: number): ByteRange | null {
  if (!header.toLowerCase().startsWith('bytes=')) {
    return null
  }

  let value = header.slice(6).trim()
  if (value.includes(',')) {
    return null
  }

  let [startRaw, endRaw] = value.split('-', 2)
  let start = startRaw ? Number.parseInt(startRaw, 10) : undefined
  let end = endRaw ? Number.parseInt(endRaw, 10) : undefined

  if ((startRaw && Number.isNaN(start)) || (endRaw && Number.isNaN(end))) {
    return null
  }

  if (start === undefined && end === undefined) {
    return null
  }

  if (size <= 0) {
    return null
  }

  if (start === undefined) {
    let suffixLength = end ?? 0
    if (suffixLength <= 0) {
      return null
    }

    let rangeStart = Math.max(size - suffixLength, 0)
    return { start: rangeStart, end: size - 1 }
  }

  if (start >= size) {
    return null
  }

  let rangeEnd = end === undefined || end >= size ? size - 1 : end
  if (rangeEnd < start) {
    return null
  }

  return { start, end: rangeEnd }
}

function buildWeakEtag(file: File) {
  let lastModified = Number.isFinite(file.lastModified) ? file.lastModified : 0
  return `W/"${lastModified}-${file.size}"`
}

function normalizeFolderPath(input: string) {
  let trimmed = input.trim()
  if (trimmed === '' || trimmed === '/') {
    return ''
  }

  let replaced = trimmed.replace(/\\/g, '/')
  let segments = replaced.split('/').filter((segment) => segment.length > 0)

  for (let segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Response('Invalid folder path.', { status: 400 })
    }
  }

  return segments.join('/')
}

function collectKeysForFolder(keys: string[], folder: string) {
  if (!folder) {
    return [...keys].sort((left, right) => left.localeCompare(right))
  }

  let prefix = `${folder}/`
  return keys
    .filter((key) => key.startsWith(prefix))
    .sort((left, right) => left.localeCompare(right))
}

function buildArchiveHeaders(filename: string) {
  let headers = new Headers()
  headers.set('Content-Type', 'application/zip')
  headers.set('Content-Disposition', attachmentDisposition(filename))
  headers.set('Cache-Control', 'private, max-age=0, must-revalidate')
  headers.set('Accept-Ranges', 'bytes')
  return headers
}

type ZipRange = {
  start: number
  end: number
}

type ZipArchiveEntry =
  | {
      kind: 'directory'
      name: string
      nameBytes: Uint8Array
      size: 0
      mtime: number
    }
  | {
      kind: 'file'
      name: string
      nameBytes: Uint8Array
      size: number
      mtime: number
      file: File
    }

// Yazl adds a 0x5455 "UT" extra field (9 bytes) to central directory entries when mtime is set.
const ZIP_CENTRAL_EXTRA_FIELD_BYTES = 9

function calculateZipSize(entries: ZipArchiveEntry[]) {
  let localTotal = 0
  let centralTotal = 0

  for (let entry of entries) {
    let nameLength = entry.nameBytes.length
    localTotal += 30 + nameLength
    if (entry.kind === 'file') {
      localTotal += entry.size + 16
    }
    let hasMtime = Number.isFinite(entry.mtime)
    let centralExtra = hasMtime ? ZIP_CENTRAL_EXTRA_FIELD_BYTES : 0
    centralTotal += 46 + nameLength + centralExtra
  }

  return localTotal + centralTotal + 22
}

function createZipStream(entries: ZipArchiveEntry[], options?: { range?: ZipRange }) {
  let baseStream = buildZipReadableStream(entries)
  let range = options?.range
  if (!range) {
    return baseStream
  }
  return sliceZipStream(baseStream, range)
}

function buildZipReadableStream(entries: ZipArchiveEntry[]) {
  let zipFile = new ZipFile()

  for (let entry of entries) {
    let mtime = new Date(entry.mtime)
    if (entry.kind === 'directory') {
      zipFile.addEmptyDirectory(entry.name, { mtime })
      continue
    }

    let fileStream = entry.file.stream() as unknown as NodeReadableStream<Uint8Array>
    let readStream = Readable.fromWeb(fileStream)
    zipFile.addReadStream(readStream, entry.name, {
      mtime,
      compress: false,
    })
  }

  zipFile.end()
  let nodeStream = Readable.toWeb(
    zipFile.outputStream as unknown as Readable,
  ) as NodeReadableStream<Uint8Array>
  return nodeStream as unknown as ReadableStream<Uint8Array>
}

function sliceZipStream(stream: ReadableStream<Uint8Array>, range: ZipRange) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = stream.getReader()
      let position = 0

      try {
        while (reader) {
          let { done, value } = await reader.read()
          if (done) {
            controller.close()
            break
          }
          if (!value) {
            continue
          }

          let chunk = value
          let chunkStart = position
          let chunkEnd = chunkStart + chunk.length - 1
          position += chunk.length

          if (chunkEnd < range.start) {
            continue
          }

          if (chunkStart > range.end) {
            await reader.cancel()
            controller.close()
            break
          }

          let sliceStart = Math.max(range.start - chunkStart, 0)
          let sliceEnd = Math.min(range.end - chunkStart + 1, chunk.length)
          if (sliceEnd > sliceStart) {
            controller.enqueue(chunk.subarray(sliceStart, sliceEnd))
          }

          if (chunkEnd >= range.end) {
            await reader.cancel()
            controller.close()
            break
          }
        }
      } catch (error) {
        if (reader) {
          await reader.cancel(error)
        }
        controller.error(error)
      } finally {
        if (reader) {
          reader.releaseLock()
          reader = null
        }
      }
    },
    async cancel(reason) {
      if (reader) {
        await reader.cancel(reason)
        reader.releaseLock()
        reader = null
      }
    },
  })
}

function sanitizeArchivePath(path: string) {
  let replaced = path.replace(/\\/g, '/')
  let segments = replaced.split('/').filter((segment) => segment.length > 0)

  let safeSegments: string[] = []
  for (let segment of segments) {
    if (segment === '.' || segment === '..') {
      continue
    }
    safeSegments.push(segment)
  }

  return safeSegments.join('/')
}

function resolveRelativePath({
  key,
  normalized,
  fallback,
}: {
  key: string
  normalized: string
  fallback: string
}) {
  let relative = normalized ? key.slice(normalized.length + 1) : key
  let primary = sanitizeArchivePath(relative)
  if (primary) {
    return primary
  }

  let fromKey = sanitizeArchivePath(key)
  if (fromKey) {
    return fromKey
  }

  let fallbackSanitized = sanitizeArchivePath(fallback)
  if (fallbackSanitized) {
    return fallbackSanitized
  }

  return `file-${simpleHash(key)}`
}

function buildZipFilePath(root: string, relative: string) {
  return relative ? `${root}/${relative}` : root
}

function buildZipDirectoryPath(root: string, relative: string) {
  if (relative === '') {
    return `${root}/`
  }
  return `${root}/${relative}/`
}

function normalizeTimestamp(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return Date.now()
  }
  return value
}

function buildFolderEtag(token: string, folder: string, size: number) {
  let cleanFolder = folder ? folder.replace(/[^a-zA-Z0-9_-]/g, '-') : 'root'
  return `W/"folder-${token}-${cleanFolder}-${size}"`
}

function simpleHash(input: string) {
  let hash = 0
  for (let index = 0; index < input.length; index++) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0
  }
  return hash.toString(16)
}
