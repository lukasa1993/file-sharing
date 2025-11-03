import type { RequestContext } from '@remix-run/fetch-router'

import { storeUploadedFiles, deleteFileAndShares } from '../../models/admin.server.ts'
import { readContextFormData } from '../../utils/form-data.ts'
import { requireAdminSession } from '../auth/admin.tsx'
import { redirectToDashboard } from './redirects.ts'

export async function adminUpload(context: RequestContext<'POST'>) {
  let session = requireAdminSession(context)
  if (session instanceof Response) return session

  let formData = await readContextFormData(context)
  let files = formData.getAll('files').filter((value): value is File => value instanceof File)

  if (files.length === 0) {
    return redirectToDashboard(context.request, { error: 'Select at least one file to upload.' })
  }

  await storeUploadedFiles(files)

  return redirectToDashboard(context.request, {
    message: `Uploaded ${files.length} file${files.length === 1 ? '' : 's'}.`,
  })
}

export async function adminDeleteFile(context: RequestContext<'POST'>) {
  let session = requireAdminSession(context)
  if (session instanceof Response) return session

  let formData = await readContextFormData(context)
  let key = formData.get('key')

  if (typeof key !== 'string' || key.length === 0) {
    return redirectToDashboard(context.request, { error: 'Invalid file key.' })
  }

  await deleteFileAndShares(key)

  return redirectToDashboard(context.request, { message: 'File deleted successfully.' })
}
