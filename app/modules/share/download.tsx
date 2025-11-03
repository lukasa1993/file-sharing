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

export async function handleDownloadShare({ token, request }: DownloadShareParams) {
  let share = findShare(token)

  if (!share || share.kind !== 'download') {
    return shareUnavailable('Download share not found or expired.')
  }

  let url = new URL(request.url)
  let key = url.searchParams.get('file')

  if (key) {
    return respondWithFileDownload({ key, share, request })
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
