import { routes } from '../../../routes.ts'
import { redirectWithSearch } from '../../utils/redirect.ts'

type DashboardRedirectOptions = {
  message?: string
  error?: string
  share?: string
}

export function redirectToDashboard(request: Request, options: DashboardRedirectOptions = {}) {
  return redirectWithSearch(request, routes.admin.index.href(), {
    params: {
      message: options.message,
      error: options.error,
      share: options.share,
    },
  })
}
