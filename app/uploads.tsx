import type { BuildRouteHandler } from '@remix-run/fetch-router'
import type { routes } from '../routes.ts'
import { serveUploadedFile } from './modules/uploads/fetch.ts'

export let uploadsHandler: BuildRouteHandler<'GET', typeof routes.uploads> = async ({ params }) => {
  return serveUploadedFile(params.key)
}
