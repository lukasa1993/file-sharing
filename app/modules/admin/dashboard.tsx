import type { RequestContext } from '@remix-run/fetch-router'

import { render } from '../../utils/render.ts'
import { getDashboardData } from '../../models/admin.server.ts'
import { AdminDashboardPage } from '../../components/admin/AdminDashboardPage.tsx'
import { requireAdminSession } from '../auth/admin.tsx'

export async function adminDashboard(context: RequestContext) {
  let session = requireAdminSession(context)
  if (session instanceof Response) return session

  let message = context.url.searchParams.get('message') ?? undefined
  let error = context.url.searchParams.get('error') ?? undefined
  let highlightToken = context.url.searchParams.get('share') ?? undefined
  let path = context.url.searchParams.get('path') ?? undefined

  let { directory, shares } = await getDashboardData(path)

  return render(
    <AdminDashboardPage
      user={session}
      directory={directory}
      shares={shares}
      message={message}
      error={error}
      highlightToken={highlightToken}
      currentPath={directory.path}
      baseUrl={context.request.url}
    />,
  )
}
