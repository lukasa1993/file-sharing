import { Cause, Effect, Exit } from 'effect'
import { AppError, defaultBrand, type AppConfig } from './contracts.ts'
import { boundedRequest, errorBody, go, isPage } from './http.ts'
import { applicationServices, createRuntime } from './runtime.ts'
import { appRouter, type RequestAudit } from './router.ts'
import { renderError } from './ui/index.tsx'
import { trustedProxyPeers } from './proxy.ts'
import { attempt } from './effects.ts'
import { recordResponse } from './monitoring.ts'

// Only fixed route labels may enter logs. Public aliases and path arguments are private.
const publicRoutes = new Set(['/', '/login', '/logout', '/healthz', '/readyz'])
function operationLabel(pathname: string) {
  if (publicRoutes.has(pathname)) return pathname
  if (!pathname.startsWith('/_/')) return 'public'
  return (
    /^\/_\/(api|files|folder-permissions|shares|account|admin|trash|preview|inspect|download|archive|uploads|events)(?=\/|$)/.exec(
      pathname,
    )?.[0] ?? 'internal'
  )
}

export async function createApp(config: AppConfig) {
  const clientPeer = trustedProxyPeers(config.trustedProxies ?? [])
  const auditContext = new WeakMap<Request, RequestAudit>()
  const runtime = createRuntime(config)
  let services: Effect.Success<typeof applicationServices>
  let router: Awaited<ReturnType<typeof appRouter>>
  try {
    services = await runtime.runPromise(applicationServices)
    router = await appRouter(services, auditContext)
  } catch (error) {
    await runtime.dispose()
    throw error
  }
  const origin = new URL(config.publicOrigin)
  async function fetchRequest(incoming: Request, peer?: string) {
    const id = crypto.randomUUID(),
      start = performance.now()
    const url = new URL(incoming.url)
    const operation = operationLabel(url.pathname)
    const record: RequestAudit = {}
    let response: Response
    try {
      const host = incoming.headers.get('host') || url.host
      if (
        host.toLowerCase() !== origin.host.toLowerCase() ||
        url.host.toLowerCase() !== origin.host.toLowerCase()
      )
        throw new AppError(421, 'Unknown host')
      const remote = clientPeer(peer, incoming)
      if (remote) record.peer = remote
      const request = await boundedRequest(
        incoming,
        services.transfers.contentPolicy.current.textPreviewKiB * 1024,
      )
      auditContext.set(request, record)
      const result = await runtime.runPromiseExit(
        attempt(() => router.fetch(request)).pipe(
          Effect.withSpan('http.request', {
            attributes: { 'request.id': id, operation },
          }),
        ),
        { signal: request.signal },
      )
      if (Exit.isFailure(result)) throw Cause.squash(result.cause)
      response = result.value
    } catch (error) {
      const { status, message } = errorBody(error, id)
      if (
        status === 401 &&
        incoming.method === 'GET' &&
        isPage(url, incoming)
      ) {
        response = go(
          '/login?' + new URLSearchParams({ next: url.pathname + url.search }),
        )
      } else if (isPage(url, incoming))
        response = await renderError({
          status,
          message,
          brand: services.meta.value('brand', defaultBrand),
        })
      else
        response = Response.json(
          { error: { code: 'HTTP_' + status, message, requestId: id } },
          { status },
        )
      if (status >= 500 && status !== 503)
        console.error(
          JSON.stringify({
            event: 'request.error',
            requestId: id,
            operation,
            status,
            kind: error instanceof Error ? error.name : 'Unexpected',
          }),
        )
    }
    // Construct a new header collection even for immutable redirects and preserve cookies separately.
    const headers = new Headers(response.headers)
    headers.set('X-Request-ID', id)
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('X-Frame-Options', 'DENY')
    // Same-origin form navigation needs its Origin for Remix CSRF validation.
    // Preserve the stricter policy on raw downloads and sandboxed previews.
    if (!headers.has('Referrer-Policy'))
      headers.set('Referrer-Policy', 'same-origin')
    if (!headers.has('Content-Security-Policy'))
      headers.set(
        'Content-Security-Policy',
        "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      )
    if (origin.protocol === 'https:')
      headers.set('Strict-Transport-Security', 'max-age=31536000')
    if (!url.pathname.startsWith('/assets/'))
      headers.set('Cache-Control', 'private, no-store, no-transform')
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(incoming.method) ||
      response.status >= 400
    ) {
      try {
        services.meta.log(
          id,
          record.actorId ?? null,
          operation,
          response.status,
          Math.round(performance.now() - start),
        )
      } catch {
        console.error(
          JSON.stringify({ event: 'audit.write_failed', requestId: id }),
        )
      }
    }
    if (incoming.method === 'HEAD' && response.body)
      await response.body.cancel()
    runtime.runSync(recordResponse(response.status, performance.now() - start))
    return new Response(incoming.method === 'HEAD' ? null : response.body, {
      status: response.status,
      headers,
    })
  }
  return { fetch: fetchRequest, services, close: () => runtime.dispose() }
}
