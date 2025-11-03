import type { RequestContext } from '@remix-run/fetch-router'

import {
  createDownloadShareLink,
  createUploadShareLink,
  revokeShareToken,
} from '../../models/admin.server.ts'
import { readContextFormData } from '../../utils/form-data.ts'
import { parseByteLimit, parsePositiveInteger } from '../../utils/numbers.ts'
import { requireAdminSession } from '../auth/admin.tsx'
import { redirectToDashboard } from './redirects.ts'

export async function adminCreateDownloadShare(context: RequestContext<'POST'>) {
  let session = requireAdminSession(context)
  if (session instanceof Response) return session

  let formData = await readContextFormData(context)
  let keys = formData
    .getAll('keys')
    .map((value) => (typeof value === 'string' ? value : ''))
    .filter((value) => value.length > 0)

  if (keys.length === 0) {
    return redirectToDashboard(context.request, { error: 'Select one or more files to share.' })
  }

  let expiresIn = parsePositiveInteger(formData.get('expiresIn'))

  try {
    let share = await createDownloadShareLink(keys, { expiresInMinutes: expiresIn })
    return redirectToDashboard(context.request, {
      message: 'Download share link created.',
      share: share.token,
    })
  } catch (error) {
    return redirectToDashboard(context.request, { error: (error as Error).message })
  }
}

export async function adminCreateUploadShare(context: RequestContext<'POST'>) {
  let session = requireAdminSession(context)
  if (session instanceof Response) return session

  let formData = await readContextFormData(context)
  let expiresIn = parsePositiveInteger(formData.get('expiresIn'))
  let maxBytes = parseByteLimit(formData.get('maxSizeValue'), formData.get('maxSizeUnit'))

  let share = await createUploadShareLink({
    expiresInMinutes: expiresIn,
    maxBytes: maxBytes && maxBytes > 0 ? maxBytes : undefined,
  })

  return redirectToDashboard(context.request, {
    message: 'Upload share link created.',
    share: share.token,
  })
}

export async function adminRevokeShare(context: RequestContext<'POST'>) {
  let session = requireAdminSession(context)
  if (session instanceof Response) return session

  let formData = await readContextFormData(context)
  let token = formData.get('token')

  if (typeof token !== 'string' || token.length === 0) {
    return redirectToDashboard(context.request, { error: 'Unknown share token.' })
  }

  await revokeShareToken(token)

  return redirectToDashboard(context.request, { message: 'Share token revoked.' })
}
