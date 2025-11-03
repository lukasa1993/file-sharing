import type { RequestContext } from '@remix-run/fetch-router'

import {
  collectDownloadShareKeys,
  createDownloadShareLink,
  createUploadShareLink,
  revokeShareToken,
} from '../../models/admin.server.ts'
import { readContextFormData } from '../../utils/form-data.ts'
import { parseByteLimit, parseNonNegativeInteger } from '../../utils/numbers.ts'
import { requireAdminSession } from '../auth/admin.tsx'
import { redirectToDashboard } from './redirects.ts'

export async function adminCreateDownloadShare(context: RequestContext<'POST'>) {
  let session = requireAdminSession(context)
  if (session instanceof Response) return session

  let formData = await readContextFormData(context)
  let pathField = formData.get('path')
  let currentPath = typeof pathField === 'string' ? pathField : ''

  let selectionValues = formData
    .getAll('entries')
    .map((value) => (typeof value === 'string' ? value : ''))
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

  if (selectionValues.length === 0) {
    return redirectToDashboard(context.request, {
      error: 'Select at least one file or folder to share.',
      path: currentPath,
    })
  }

  let fileKeys = new Set<string>()
  let directoryKeys = new Set<string>()

  for (let value of selectionValues) {
    if (value.startsWith('file:')) {
      let key = value.slice('file:'.length)
      if (key) {
        fileKeys.add(key)
      }
      continue
    }
    if (value.startsWith('directory:')) {
      let directory = value.slice('directory:'.length)
      if (directory) {
        directoryKeys.add(directory)
      }
      continue
    }
    fileKeys.add(value)
  }

  if (fileKeys.size === 0 && directoryKeys.size === 0) {
    return redirectToDashboard(context.request, {
      error: 'Select at least one valid file or folder to share.',
      path: currentPath,
    })
  }

  let expiresIn = parseNonNegativeInteger(formData.get('expiresIn'))

  try {
    let expandedKeys = await collectDownloadShareKeys(
      Array.from(fileKeys),
      Array.from(directoryKeys),
    )
    let share = await createDownloadShareLink(expandedKeys, { expiresInMinutes: expiresIn })
    return redirectToDashboard(context.request, {
      message: 'Download share link created.',
      share: share.token,
      path: currentPath,
    })
  } catch (error) {
    return redirectToDashboard(context.request, {
      error: (error as Error).message,
      path: currentPath,
    })
  }
}

export async function adminCreateUploadShare(context: RequestContext<'POST'>) {
  let session = requireAdminSession(context)
  if (session instanceof Response) return session

  let formData = await readContextFormData(context)
  let expiresIn = parseNonNegativeInteger(formData.get('expiresIn'))
  let maxBytes = parseByteLimit(formData.get('maxSizeValue'), formData.get('maxSizeUnit'))
  let pathField = formData.get('path')
  let currentPath = typeof pathField === 'string' ? pathField : ''

  let targetDirectory = currentPath.trim()

  if (targetDirectory === '') {
    return redirectToDashboard(context.request, {
      error: 'Choose or create a folder before generating an upload link.',
      path: currentPath,
    })
  }

  try {
    let share = await createUploadShareLink({
      expiresInMinutes: expiresIn,
      maxBytes: maxBytes && maxBytes > 0 ? maxBytes : undefined,
      targetDirectory,
    })

    return redirectToDashboard(context.request, {
      message: 'Upload share link created.',
      share: share.token,
      path: currentPath,
    })
  } catch (error) {
    return redirectToDashboard(context.request, {
      error: (error as Error).message,
      path: currentPath,
    })
  }
}

export async function adminRevokeShare(context: RequestContext<'POST'>) {
  let session = requireAdminSession(context)
  if (session instanceof Response) return session

  let formData = await readContextFormData(context)
  let token = formData.get('token')
  let pathField = formData.get('path')
  let currentPath = typeof pathField === 'string' ? pathField : ''

  if (typeof token !== 'string' || token.length === 0) {
    return redirectToDashboard(context.request, {
      error: 'Unknown share token.',
      path: currentPath,
    })
  }

  await revokeShareToken(token)

  return redirectToDashboard(context.request, {
    message: 'Share token revoked.',
    path: currentPath,
  })
}
