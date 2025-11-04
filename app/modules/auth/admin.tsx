import type { RequestContext } from '@remix-run/fetch-router'
import { createStorageKey } from '@remix-run/fetch-router'

import { routes } from '../../../routes.ts'
import { config } from '../../config.ts'
import { render } from '../../utils/render.ts'
import {
  createSessionCookie,
  clearSessionCookie,
  getSessionFromRequest,
  type SessionData,
} from '../../utils/session.ts'
import { readContextFormData } from '../../utils/form-data.ts'
import { AdminLoginPage } from '../../components/auth/AdminLoginPage.tsx'
import { resolveSafeRedirect } from '../../utils/redirect.ts'

const adminSessionKey = createStorageKey<SessionData | null>(null)

export function requireAdminSession(context: RequestContext): SessionData | Response {
  let session = getAdminSession(context)
  if (session) {
    return session
  }

  let loginUrl = new URL(routes.admin.login.index.href(), context.request.url)
  let redirectPath = context.url.pathname + context.url.search
  loginUrl.searchParams.set('redirect', redirectPath)
  return Response.redirect(loginUrl.toString(), 303)
}

export function getAdminSession(context: RequestContext): SessionData | null {
  if (context.storage.has(adminSessionKey)) {
    return context.storage.get(adminSessionKey)
  }

  let session = getSessionFromRequest(context.request)
  context.storage.set(adminSessionKey, session ?? null)
  return session ?? null
}

export async function adminLoginView(context: RequestContext) {
  let session = getAdminSession(context)
  if (session) {
    return Response.redirect(routes.admin.index.href(), 303)
  }

  let error = context.url.searchParams.get('error') ?? undefined
  let redirectTarget = resolveSafeRedirect(
    context.request,
    context.url.searchParams.get('redirect'),
    routes.admin.index.href(),
  )
  let actionUrl = `${routes.admin.login.action.href()}?redirect=${encodeURIComponent(redirectTarget)}`

  return render(<AdminLoginPage error={error} actionUrl={actionUrl} />)
}

export async function adminLoginAction(context: RequestContext<'POST'>) {
  let formData = await readContextFormData(context)
  let username = formData.get('username')
  let password = formData.get('password')
  let redirectTarget = resolveSafeRedirect(
    context.request,
    context.url.searchParams.get('redirect'),
    routes.admin.index.href(),
  )

  if (typeof username !== 'string' || typeof password !== 'string') {
    return renderLoginError(context, redirectTarget, 'Enter both username and password.')
  }

  if (username !== config.adminUser) {
    return renderLoginError(context, redirectTarget, 'Invalid credentials. Please try again.')
  }

  let passwordMatches = await Bun.password.verify(password, config.adminPasswordHash)
  if (!passwordMatches) {
    return renderLoginError(context, redirectTarget, 'Invalid credentials. Please try again.')
  }

  return new Response(null, {
    status: 303,
    headers: {
      'Set-Cookie': createSessionCookie(username),
      Location: redirectTarget,
    },
  })
}

export async function adminLogout(context: RequestContext<'POST'>) {
  let redirectTarget = resolveSafeRedirect(
    context.request,
    context.url.searchParams.get('redirect'),
    routes.admin.login.index.href(),
  )
  return new Response(null, {
    status: 303,
    headers: {
      'Set-Cookie': clearSessionCookie(),
      Location: redirectTarget,
    },
  })
}

function renderLoginError(context: RequestContext, redirectTarget: string, message: string) {
  let actionUrl = `${routes.admin.login.action.href()}?redirect=${encodeURIComponent(redirectTarget)}`
  return render(<AdminLoginPage error={message} actionUrl={actionUrl} />, { status: 401 })
}
