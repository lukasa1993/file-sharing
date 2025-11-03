import type { BuildRouteHandler, RouteHandlers } from '@remix-run/fetch-router'

import { routes } from '../routes.ts'
import { handleDownloadShare } from './modules/share/download.tsx'
import { handleUploadShareView, handleUploadShareAction } from './modules/share/upload.tsx'

export let downloadShareHandler: BuildRouteHandler<'GET', typeof routes.share.download> = async ({
  params,
  request,
}) => {
  return handleDownloadShare({ token: params.token, request })
}

export let uploadShareHandlers: RouteHandlers<typeof routes.share.upload> = {
  index({ params, request }) {
    return handleUploadShareView({ token: params.token, request })
  },

  async action({ params, request }) {
    return handleUploadShareAction({ token: params.token, request })
  },
}
