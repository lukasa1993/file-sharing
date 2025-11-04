import type { BuildRouteHandler } from '@remix-run/fetch-router'
import type { routes } from '../routes.ts'
import { requireAdminSession } from './modules/auth/admin.tsx'
import { serveUploadedFile } from './modules/uploads/fetch.ts'

export let uploadsHandler: BuildRouteHandler<'GET', typeof routes.uploads> = async (context) => {
  let session = requireAdminSession(context)
  if (session instanceof Response) {
    return session
  }

  return serveUploadedFile(context.params.key)
}
