import type { RequestContext } from '@remix-run/fetch-router'

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

export async function adminUpload(context: RequestContext<'POST'>) {
  let session = requireAdminSession(context)
  if (session instanceof Response) return session

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
  let pathField = formData.get('path')

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
    .getAll('entries')
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
  let pathField = formData.get('path')

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
