import { createRouter } from '@remix-run/fetch-router'
import { formData } from '@remix-run/fetch-router/form-data-middleware'
import { logger } from '@remix-run/fetch-router/logger-middleware'
import { methodOverride } from '@remix-run/fetch-router/method-override-middleware'

import { routes } from '../routes.ts'
import adminHandlers from './admin.tsx'
import { storeContext } from './middleware/context.ts'
import { downloadShareHandler, uploadShareHandlers } from './share.tsx'
import { uploadsHandler } from './uploads.tsx'
import { uploadHandler } from './utils/uploads.ts'

let middleware = []

if (process.env.NODE_ENV === 'development') {
  middleware.push(logger())
}

middleware.push(formData({ uploadHandler }))
middleware.push(methodOverride())
middleware.push(storeContext())

export let router = createRouter({ middleware })

router.get(routes.uploads, uploadsHandler)
router.map(routes.admin, adminHandlers)
router.get(routes.share.download, downloadShareHandler)
router.map(routes.share.upload, uploadShareHandlers)
