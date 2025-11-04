import type { RequestContext } from '@remix-run/fetch-router'

import { Buffer } from 'node:buffer'

import {
  storeUploadedFiles,
  deleteFileAndShares,
  deleteDirectoryAndShares,
  createDirectory,
  moveEntriesToDirectory,
} from '../../models/admin.server.ts'
import { isIgnoredUpload } from '../../utils/uploads.ts'
import { readContextFormData } from '../../utils/form-data.ts'
import { requireAdminSession } from '../auth/admin.tsx'
import { redirectToDashboard } from './redirects.ts'
import { config } from '../../config.ts'
import { formatBytes } from '../../utils/format.ts'
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
import { routes } from '../../../routes.ts'

const RESUMABLE_ROOT = config.resumableRoot

export async function adminUpload(context: RequestContext<'POST'>) {
  let session = requireAdminSession(context)
  if (session instanceof Response) return session

  let request = context.request

  if (isResumableUploadRequest(request)) {
    return handleAdminResumableUpload({ request })
  }

  let formData = await readContextFormData(context)
  let files = formData.getAll('files').filter((value): value is File => value instanceof File)
  let path = formData.get('path')
  let directory = typeof path === 'string' ? path : ''

  let uploadableFiles = files.filter((file) => !isIgnoredUpload(file))
  let skipped = files.length - uploadableFiles.length

  if (uploadableFiles.length === 0) {
    let errorMessage =
      files.length > 0 ? 'Only system files were selected.' : 'Select at least one file to upload.'
    return redirectToDashboard(context.request, { error: errorMessage, path: directory })
  }

  try {
    await storeUploadedFiles(uploadableFiles, { directory })
  } catch (error) {
    let message =
      error instanceof Error ? error.message : 'An unexpected error occurred while uploading.'
    return redirectToDashboard(context.request, { error: message, path: directory })
  }

  let uploadedCount = uploadableFiles.length
  let uploadMessage = `Uploaded ${uploadedCount} file${uploadedCount === 1 ? '' : 's'}.`
  if (skipped > 0) {
    uploadMessage = `${uploadMessage} Skipped ${skipped} hidden file${skipped === 1 ? '' : 's'}.`
  }

  return redirectToDashboard(context.request, {
    message: uploadMessage,
    path: directory,
  })
}

export async function adminDeleteFile(context: RequestContext<'POST'>) {
  let session = requireAdminSession(context)
  if (session instanceof Response) return session

  let formData = await readContextFormData(context)
  let key = formData.get('key')
  let path = formData.get('path')
  let directory = typeof path === 'string' ? path : ''

  if (typeof key !== 'string' || key.length === 0) {
    return redirectToDashboard(context.request, { error: 'Invalid file key.', path: directory })
  }

  try {
    await deleteFileAndShares(key)
  } catch (error) {
    let message =
      error instanceof Error ? error.message : 'An unexpected error occurred while deleting.'
    return redirectToDashboard(context.request, { error: message, path: directory })
  }

  return redirectToDashboard(context.request, {
    message: 'File deleted successfully.',
    path: directory,
  })
}

export async function adminCreateDirectory(context: RequestContext<'POST'>) {
  let session = requireAdminSession(context)
  if (session instanceof Response) return session

  let formData = await readContextFormData(context)
  let nameField = formData.get('name')
  let pathField = formData.get('path') ?? formData.get('currentPath')

  let currentPath = typeof pathField === 'string' ? pathField : ''

  if (typeof nameField !== 'string') {
    return redirectToDashboard(context.request, {
      error: 'Folder name is required.',
      path: currentPath,
    })
  }

  let name = nameField.trim()

  if (!name) {
    return redirectToDashboard(context.request, {
      error: 'Folder name is required.',
      path: currentPath,
    })
  }

  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    return redirectToDashboard(context.request, {
      error: 'Folder name contains invalid characters.',
      path: currentPath,
    })
  }

  let targetPath = currentPath ? `${currentPath}/${name}` : name

  try {
    await createDirectory(targetPath)
  } catch (error) {
    let message =
      error instanceof Error ? error.message : 'An unexpected error occurred while creating folder.'
    return redirectToDashboard(context.request, {
      error: message,
      path: currentPath,
    })
  }

  return redirectToDashboard(context.request, {
    message: `Created “${name}”.`,
    path: currentPath,
  })
}

export async function adminDeleteDirectory(context: RequestContext<'POST'>) {
  let session = requireAdminSession(context)
  if (session instanceof Response) return session

  let formData = await readContextFormData(context)
  let targetField = formData.get('directory')
  let pathField = formData.get('path')
  let currentPath = typeof pathField === 'string' ? pathField : ''

  if (typeof targetField !== 'string' || targetField.length === 0) {
    return redirectToDashboard(context.request, {
      error: 'Invalid directory path.',
      path: currentPath,
    })
  }

  try {
    await deleteDirectoryAndShares(targetField)
  } catch (error) {
    let message =
      error instanceof Error ? error.message : 'An unexpected error occurred while deleting folder.'
    return redirectToDashboard(context.request, {
      error: message,
      path: currentPath,
    })
  }

  return redirectToDashboard(context.request, {
    message: 'Folder deleted successfully.',
    path: currentPath,
  })
}

export async function adminMoveEntries(context: RequestContext<'POST'>) {
  let session = requireAdminSession(context)
  if (session instanceof Response) return session

  let formData = await readContextFormData(context)
  let entries = formData
    .getAll('selection')
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0)
  let normalizedEntries = Array.from(
    new Set(
      entries
        .map((value) => {
          if (value.startsWith('file:')) {
            return value.slice('file:'.length)
          }
          if (value.startsWith('directory:')) {
            return value.slice('directory:'.length)
          }
          return value
        })
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  )
  let destinationField = formData.get('destination')
  let pathField = formData.get('path') ?? formData.get('currentPath')

  let currentPath = typeof pathField === 'string' ? pathField : ''
  let destinationPath = typeof destinationField === 'string' ? destinationField.trim() : ''

  if (normalizedEntries.length === 0) {
    return redirectToDashboard(context.request, {
      error: 'Select one or more items to move.',
      path: currentPath,
    })
  }

  try {
    let result = await moveEntriesToDirectory(normalizedEntries, destinationPath)

    if (result.entries.length === 0) {
      return redirectToDashboard(context.request, {
        error: 'Nothing to move. Items may already be in that location.',
        path: currentPath,
      })
    }

    let movedCount = result.entries.length
    let destinationLabel = destinationPath ? `/${destinationPath}` : 'the root folder'

    return redirectToDashboard(context.request, {
      message: `Moved ${movedCount} item${movedCount === 1 ? '' : 's'} to ${destinationLabel}.`,
      path: currentPath,
    })
  } catch (error) {
    let message =
      error instanceof Error ? error.message : 'An unexpected error occurred while moving items.'
    return redirectToDashboard(context.request, {
      error: message,
      path: currentPath,
    })
  }
}

function isResumableUploadRequest(request: Request) {
  return request.headers.get('x-upload-mode') === 'resumable'
}

async function handleAdminResumableUpload({ request }: { request: Request }) {
  if (request.method.toUpperCase() !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, { status: 405 })
  }

  let uploadId = sanitizeSegment(request.headers.get('x-upload-id'))
  if (!uploadId) {
    return jsonResponse({ error: 'Missing upload identifier.' }, { status: 400 })
  }

  let contentRange = parseContentRange(request.headers.get('content-range'))
  if (!contentRange) {
    return jsonResponse({ error: 'Missing content range metadata.' }, { status: 400 })
  }

  let totalSizeHeader = request.headers.get('x-file-size')
  let totalSize = totalSizeHeader ? Number.parseInt(totalSizeHeader, 10) : Number.NaN
  if (!Number.isFinite(totalSize) || totalSize <= 0) {
    return jsonResponse({ error: 'Invalid file size.' }, { status: 400 })
  }

  if (totalSize !== contentRange.total) {
    return jsonResponse({ error: 'Chunk size mismatch.' }, { status: 400 })
  }

  let chunkLength = contentRange.end - contentRange.start + 1
  if (chunkLength <= 0) {
    return jsonResponse({ error: 'Empty chunk received.' }, { status: 400 })
  }

  let directoryPath = decodeUploadHeader(request.headers.get('x-upload-path'))?.trim() ?? ''

  let adminScope = directoryPath
    ? `admin-${Buffer.from(directoryPath).toString('base64url')}`
    : 'admin'

  let { directory, dataPath, metaPath } = await prepareResumableSlot({
    root: RESUMABLE_ROOT,
    scope: adminScope,
    uploadId,
  })

  let meta = await readResumableMeta(metaPath)
  if (!meta) {
    if (contentRange.start !== 0) {
      return jsonResponse({ error: 'Upload metadata missing for chunk.' }, { status: 409 })
    }
    let fileName = decodeUploadHeader(request.headers.get('x-file-name')) ?? 'upload.bin'
    let fileType = decodeUploadHeader(request.headers.get('x-file-type')) ?? 'application/octet-stream'
    let relativePath = decodeUploadHeader(request.headers.get('x-file-relative-path')) ?? ''
    let lastModifiedHeader = request.headers.get('x-file-last-modified')
    let lastModified = lastModifiedHeader ? Number.parseInt(lastModifiedHeader, 10) : Number.NaN
    if (!Number.isFinite(lastModified) || lastModified <= 0) {
      lastModified = Date.now()
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
  } else if (meta.size !== totalSize) {
    return jsonResponse({ error: 'Upload metadata mismatch.' }, { status: 409 })
  }

  let chunkBuffer = new Uint8Array(await request.arrayBuffer())
  if (chunkBuffer.length !== chunkLength) {
    return jsonResponse({ error: 'Chunk payload mismatch.' }, { status: 400 })
  }

  let existingSize = await getFileSize(dataPath)
  if (existingSize != null && contentRange.start > existingSize) {
    return jsonResponse({ error: 'Unexpected chunk offset.' }, { status: 409 })
  }

  let resultingSize: number
  try {
    resultingSize = await writeResumableChunk(dataPath, chunkBuffer, contentRange.start)
  } catch (error) {
    let message = error instanceof Error ? error.message : 'Unable to write chunk.'
    let status = message.toLowerCase().includes('offset') ? 409 : 500
    return jsonResponse({ error: message }, { status })
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

  return finalizeAdminResumableUpload({
    request,
    meta,
    slotDirectory: directory,
    dataPath,
    targetDirectory: directoryPath,
  })
}

async function finalizeAdminResumableUpload({
  request,
  meta,
  slotDirectory,
  dataPath,
  targetDirectory,
}: {
  request: Request
  meta: ResumableMeta
  slotDirectory: string
  dataPath: string
  targetDirectory: string
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

    if (isIgnoredUpload(file, meta.relativePath)) {
      let displayName = meta.relativePath || meta.name
      return jsonResponse({
        redirect: buildDashboardRedirectPath(request, {
          message: `Skipped hidden file “${displayName}”.`,
          path: targetDirectory,
        }),
      })
    }

    try {
      await storeUploadedFiles([file], { directory: targetDirectory })
    } catch (error) {
      let message =
        error instanceof Error ? error.message : 'An unexpected error occurred while uploading.'
      return jsonResponse({ error: message }, { status: 500 })
    }

    let displayName = meta.relativePath || meta.name
    let message = `Uploaded ${displayName} (${formatBytes(meta.size)}).`

    return jsonResponse({
      redirect: buildDashboardRedirectPath(request, {
        message,
        path: targetDirectory,
      }),
    })
  } finally {
    await cleanupResumableSlot(slotDirectory)
  }
}

function buildDashboardRedirectPath(
  request: Request,
  options: { message?: string; error?: string; path?: string },
) {
  let href = routes.admin.index.href()
  let url = new URL(href, request.url)
  if (options.message) {
    url.searchParams.set('message', options.message)
  }
  if (options.error) {
    url.searchParams.set('error', options.error)
  }
  if (options.path) {
    url.searchParams.set('path', options.path)
  }
  url.hash = 'files'
  return `${url.pathname}${url.search}${url.hash}`
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  let headers = new Headers(init?.headers)
  headers.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  })
}
