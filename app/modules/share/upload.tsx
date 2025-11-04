import type { RequestContext } from '@remix-run/fetch-router'

import {
  findShare,
  registerUploadForToken,
  revokeShareToken,
  type UploadShare,
} from '../../models/share.server.ts'
import { isDirectoryUpload, isIgnoredUpload, saveFile } from '../../utils/uploads.ts'
import { render } from '../../utils/render.ts'
import { routes } from '../../../routes.ts'
import { UploadSharePage } from '../../components/share/UploadSharePage.tsx'
import { redirectWithSearch } from '../../utils/redirect.ts'
import { shareUnavailable, uploadShareCompleted } from './responses.tsx'
import { formatBytes } from '../../utils/format.ts'
import { readContextFormData } from '../../utils/form-data.ts'
import { config } from '../../config.ts'
import {
  cleanupResumableSlot,
  decodeUploadHeader,
  getFileSize,
  parseContentRange,
  prepareResumableSlot,
  readResumableMeta,
  sanitizeSegment,
  writeResumableChunk,
  writeResumableMeta,
  type ResumableMeta,
} from '../../utils/resumable.ts'

const RESUMABLE_ROOT = config.resumableRoot

export function handleUploadShareView({ token, request }: { token: string; request: Request }) {
  let share = findShare(token)

  if (!share || share.kind !== 'upload') {
    return shareUnavailable('Upload share not found or expired.')
  }

  let url = new URL(request.url)
  let message = url.searchParams.get('message')
  let error = url.searchParams.get('error')
  let actionUrl = routes.share.upload.action.href({ token })

  return render(
    <UploadSharePage
      share={share as UploadShare}
      actionUrl={actionUrl}
      message={message ?? undefined}
      error={error ?? undefined}
    />,
  )
}

export async function handleUploadShareAction({
  token,
  context,
}: {
  token: string
  context: RequestContext<'POST', { token: string }>
}) {
  let request = context.request
  let share = findShare(token)

  if (!share || share.kind !== 'upload') {
    return respondUploadShareUnavailable(request, 'Upload share not found or expired.')
  }

  if (isResumableUploadRequest(request)) {
    return handleResumableUpload({
      token,
      request,
      share,
    })
  }

  let formData = await readContextFormData(context)
  let files = formData.getAll('files').filter((value): value is File => value instanceof File)

  let acceptedUploads = files.filter((file) => !isIgnoredUpload(file))
  let directories = acceptedUploads.filter((file) => isDirectoryUpload(file))
  let fileUploads = acceptedUploads.filter((file) => !isDirectoryUpload(file))
  let skipped = files.length - acceptedUploads.length

  if (fileUploads.length === 0) {
    let errorMessage =
      files.length > 0 ? 'Only system files were selected.' : 'Select one or more files to send.'
    return redirectToUploadShare(request, token, { error: errorMessage })
  }

  let totalBytes = fileUploads.reduce((total, file) => total + file.size, 0)

  if (share.maxBytes != null && share.maxBytes > 0) {
    let remaining = share.maxBytes - share.uploadedBytes
    if (remaining <= 0) {
      await revokeShareToken(token)
      return redirectToUploadShare(request, token, {
        error: 'This upload link has reached its limit.',
      })
    }

    if (totalBytes > remaining) {
      return redirectToUploadShare(request, token, {
        error: `Only ${formatBytes(remaining)} remaining for this link.`,
      })
    }
  }

  let destinationPrefix = share.targetDirectory ?? `share/${token}`
  await Promise.all(acceptedUploads.map((file) => saveFile(file, { prefix: destinationPrefix })))
  await registerUploadForToken(token, totalBytes)

  let updatedShare = findShare(token)
  let uploadSummary = `Uploaded ${fileUploads.length} file${
    fileUploads.length === 1 ? '' : 's'
  } (${formatBytes(totalBytes)}).`
  let addedFolders = directories.length
  if (addedFolders > 0) {
    uploadSummary = `${uploadSummary} Added ${addedFolders} folder${addedFolders === 1 ? '' : 's'}.`
  }
  let skippedMessage =
    skipped > 0 ? ` Skipped ${skipped} hidden file${skipped === 1 ? '' : 's'}.` : ''

  if (!updatedShare || updatedShare.kind !== 'upload') {
    return respondUploadCompleted(
      request,
      `${uploadSummary}${skippedMessage} Upload link has reached its limit and is now closed.`,
    )
  }

  let successMessage = `${uploadSummary}${skippedMessage} Files delivered successfully.`

  return redirectToUploadShare(request, token, {
    message: successMessage,
  })
}

function redirectToUploadShare(
  request: Request,
  token: string,
  options: { message?: string; error?: string; completed?: boolean } = {},
) {
  if (wantsJsonResponse(request)) {
    let redirectPath = options.completed
      ? null
      : buildUploadRedirectPath(request, token, options)
    let status = options.error ? 422 : 200
    return jsonResponse(
      {
        redirect: redirectPath,
        message: options.message,
        error: options.error,
        completed: options.completed ?? false,
      },
      { status },
    )
  }

  return redirectWithSearch(request, routes.share.upload.index.href({ token }), {
    params: {
      message: options.message,
      error: options.error,
    },
  })
}

function respondUploadShareUnavailable(request: Request, message: string) {
  if (wantsJsonResponse(request)) {
    return jsonResponse({ error: message }, { status: 404 })
  }
  return shareUnavailable(message)
}

function respondUploadCompleted(request: Request, message: string) {
  if (wantsJsonResponse(request)) {
    return jsonResponse({ completed: true, message }, { status: 200 })
  }
  return uploadShareCompleted(message)
}

function wantsJsonResponse(request: Request) {
  return request.headers.get('x-upload-mode') === 'resumable'
}

function isResumableUploadRequest(request: Request) {
  return wantsJsonResponse(request)
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  let headers = new Headers(init?.headers)
  headers.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  })
}

function buildUploadRedirectPath(
  request: Request,
  token: string,
  options: { message?: string; error?: string },
) {
  let href = routes.share.upload.index.href({ token })
  let url = new URL(href, request.url)
  if (options.message) {
    url.searchParams.set('message', options.message)
  }
  if (options.error) {
    url.searchParams.set('error', options.error)
  }
  return `${url.pathname}${url.search}`
}

async function handleResumableUpload({
  token,
  request,
  share,
}: {
  token: string
  request: Request
  share: UploadShare
}) {
  if (request.method.toUpperCase() !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, { status: 405 })
  }

  let uploadId = sanitizeSegment(request.headers.get('x-upload-id'))
  if (!uploadId) {
    return jsonResponse({ error: 'Missing upload identifier.' }, { status: 400 })
  }

  let contentRange = parseContentRange(request.headers.get('content-range'))

  let totalSizeHeader = request.headers.get('x-file-size')
  let totalSize = totalSizeHeader ? Number.parseInt(totalSizeHeader, 10) : Number.NaN
  if (!Number.isFinite(totalSize) || totalSize <= 0) {
    return jsonResponse({ error: 'Invalid file size.' }, { status: 400 })
  }

  let fileName = decodeUploadHeader(request.headers.get('x-file-name')) ?? 'upload.bin'
  let relativePath = decodeUploadHeader(request.headers.get('x-file-relative-path')) ?? ''
  let fileType = decodeUploadHeader(request.headers.get('x-file-type')) ?? 'application/octet-stream'
  let lastModifiedHeader = request.headers.get('x-file-last-modified')
  let lastModified = lastModifiedHeader ? Number.parseInt(lastModifiedHeader, 10) : Number.NaN
  if (!Number.isFinite(lastModified) || lastModified <= 0) {
    lastModified = Date.now()
  }

  let { directory, dataPath, metaPath } = await prepareResumableSlot({
    root: RESUMABLE_ROOT,
    scope: token,
    uploadId,
  })

  let chunkBuffer = new Uint8Array(await request.arrayBuffer())

  if (!contentRange) {
    if (chunkBuffer.length !== totalSize) {
      return jsonResponse({ error: 'Missing content range metadata.' }, { status: 400 })
    }

    contentRange = {
      start: 0,
      end: chunkBuffer.length > 0 ? chunkBuffer.length - 1 : -1,
      total: totalSize,
    }
  }

  if (totalSize !== contentRange.total) {
    return jsonResponse({ error: 'Chunk size mismatch.' }, { status: 400 })
  }

  let chunkLength = contentRange.end - contentRange.start + 1
  if (chunkLength <= 0) {
    return jsonResponse({ error: 'Empty chunk received.' }, { status: 400 })
  }

  if (chunkBuffer.length !== chunkLength) {
    return jsonResponse({ error: 'Chunk payload mismatch.' }, { status: 400 })
  }

  if (share.maxBytes != null && share.maxBytes > 0) {
    let remaining = share.maxBytes - share.uploadedBytes
    if (remaining <= 0) {
      await revokeShareToken(token)
      return jsonResponse(
        { error: 'This upload link has reached its limit.', completed: true },
        { status: 410 },
      )
    }
    if (contentRange.start === 0 && totalSize > remaining) {
      return jsonResponse(
        { error: `Only ${formatBytes(remaining)} remaining for this link.` },
        { status: 413 },
      )
    }
  }

  let meta = await readResumableMeta(metaPath)
  if (!meta) {
    if (contentRange.start !== 0) {
      return jsonResponse({ error: 'Upload metadata missing for chunk.' }, { status: 409 })
    }
    meta = {
      name: fileName,
      type: fileType,
      size: totalSize,
      relativePath,
      lastModified,
      completed: false,
    }
    await writeResumableMeta(metaPath, meta)
  } else if (meta.size !== totalSize || meta.name !== fileName) {
    return jsonResponse({ error: 'Upload metadata mismatch.' }, { status: 409 })
  }

  let existingSize = await getFileSize(dataPath)
  if (existingSize != null && contentRange.start > existingSize) {
    return jsonResponse({ error: 'Unexpected chunk offset.' }, { status: 409 })
  }

  let resultingSize: number
  try {
    resultingSize = await writeResumableChunk(dataPath, chunkBuffer, contentRange.start)
  } catch (error) {
    return jsonResponse({ error: (error as Error).message || 'Unable to write chunk.' }, { status: 500 })
  }

  let nextOffset = contentRange.end + 1
  if (nextOffset < totalSize) {
    return new Response(null, {
      status: 204,
      headers: {
        'Upload-Offset': String(Math.min(nextOffset, resultingSize)),
        'Upload-Length': String(resultingSize),
      },
    })
  }

  meta.completed = true
  await writeResumableMeta(metaPath, meta)

  return finalizeResumableUpload({
    request,
    token,
    share,
    meta,
    directory,
    dataPath,
  })
}

async function finalizeResumableUpload({
  request,
  token,
  share,
  meta,
  directory,
  dataPath,
}: {
  request: Request
  token: string
  share: UploadShare
  meta: ResumableMeta
  directory: string
  dataPath: string
}) {
  try {
    let finalSize = await getFileSize(dataPath)
    if (finalSize == null || finalSize !== meta.size) {
      return jsonResponse({ error: 'Incomplete upload data.' }, { status: 400 })
    }

    let blob = Bun.file(dataPath)
    if (!(await blob.exists())) {
      return jsonResponse({ error: 'Uploaded data not found.' }, { status: 400 })
    }

    let file = new File([blob], meta.name, {
      type: meta.type,
      lastModified: meta.lastModified,
    })

    if (meta.relativePath) {
      Object.defineProperty(file, 'webkitRelativePath', {
        value: meta.relativePath,
        configurable: true,
      })
    }

    let destinationPrefix = share.targetDirectory ?? `share/${token}`
    let saved = await saveFile(file, { prefix: destinationPrefix })

    if (!saved) {
      return jsonResponse(
        {
          message: `Skipped hidden file “${meta.relativePath || meta.name}”.`,
        },
        { status: 200 },
      )
    }

    await registerUploadForToken(token, meta.size)
    let updatedShare = findShare(token)
    let displayName = meta.relativePath || meta.name

    if (!updatedShare || updatedShare.kind !== 'upload') {
      return redirectToUploadShare(request, token, {
        message: `Uploaded ${displayName} (${formatBytes(meta.size)}). Upload link has reached its limit and is now closed.`,
        completed: true,
      })
    }

    return redirectToUploadShare(request, token, {
      message: `Uploaded ${displayName} (${formatBytes(meta.size)}). Files delivered successfully.`,
    })
  } finally {
    await cleanupResumableSlot(directory)
  }
}
