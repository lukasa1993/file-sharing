import { createRouter } from '@remix-run/fetch-router'
import { formData } from '@remix-run/fetch-router/form-data-middleware'
import { logger } from '@remix-run/fetch-router/logger-middleware'
import { methodOverride } from '@remix-run/fetch-router/method-override-middleware'

import { routes } from '../routes.ts'
import adminHandlers from './admin.tsx'
import { storeContext } from './middleware/context.ts'
import { landingPageHandler } from './modules/public/landing.tsx'
import { downloadShareHandler, uploadShareHandlers } from './share.tsx'
import { assetsHandler } from './public.ts'
import { uploadsHandler } from './uploads.tsx'
import { uploadHandler } from './utils/uploads.ts'

let middleware = []
middleware.push(logger())
middleware.push(formData({ uploadHandler, maxFileSize: 1024 * 1024 * 1024 * 1024, maxFiles: 500 }))
middleware.push(methodOverride())
middleware.push(storeContext())

export let router = createRouter({ middleware, defaultHandler: landingPageHandler })

router.get(routes.assets, assetsHandler)
router.get(routes.uploads, uploadsHandler)
router.map(routes.admin, adminHandlers)
router.get(routes.share.download, downloadShareHandler)
router.map(routes.share.upload, uploadShareHandlers)
