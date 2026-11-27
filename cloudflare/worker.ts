import { TransferError, controlText } from '../shared/transfers.ts'
import { CloudCatalog } from './catalog.ts'
import { CloudIdentity } from './identity.ts'
import { sendCapacityAlert, type CloudMailEnv } from './mail.ts'
import { CloudSharing } from './sharing.ts'
import { R2Transfers, type R2Environment } from './r2.ts'
import { renderCloudPage } from './ui.ts'
import { cloudApi, type CloudApiServices } from './api.ts'
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime } from 'effect'
import { attempt } from '../app/effects.ts'
import { cleanupFile } from './transfers.ts'

export interface CloudEnvironment extends R2Environment, CloudMailEnv {
  WORKSPACE: DurableObjectNamespace
  ASSETS: Fetcher
  PUBLIC_ORIGIN: string
}

const retryMs = 60_000
function errorResponse(error: unknown) {
  if (error instanceof TransferError)
    return Response.json({ error: error.message }, { status: error.status })
  console.error('lshare cloud request failed')
  return Response.json(
    { error: 'Service temporarily unavailable.' },
    { status: 503 },
  )
}

const WorkspaceServices = Context.Service<CloudApiServices>(
  'lshare/cloud/Workspace',
)

function openRuntime(
  state: DurableObjectState,
  env: CloudEnvironment,
  endpoint?: string,
) {
  const layer = Layer.sync(WorkspaceServices, () => {
    const catalog = new CloudCatalog(state.storage)
    const sharing = new CloudSharing(state.storage.sql, (owner, id, now) => {
      const file = catalog.ready(id, now)
      return file?.ownerId === owner ? file : null
    })
    return {
      catalog,
      sharing,
      identity: new CloudIdentity(state.storage),
      r2: new R2Transfers(env, endpoint ? { endpoint } : {}),
    }
  })
  return ManagedRuntime.make(layer)
}

function deliverAlerts(catalog: CloudCatalog, env: CloudEnvironment) {
  return Effect.forEach(
    catalog.claimAlerts(Date.now()),
    (alert) =>
      attempt(() =>
        sendCapacityAlert(
          env,
          'lshare crossed its 3.6 GB storage warning at ' +
            new Date(alert.createdAt).toISOString() +
            '. Stored and reserved files accounted for ' +
            alert.bytes.toLocaleString('en-US') +
            ' bytes of the 4,000,000,000-byte limit. Review your storage at ' +
            env.PUBLIC_ORIGIN +
            '.',
        ),
      ).pipe(
        Effect.match({
          onSuccess: () => {
            catalog.ackAlert(alert.id, alert.token)
          },
          onFailure: () => {
            catalog.releaseAlert(alert.id, alert.token, Date.now() + retryMs)
            console.error('lshare storage alert awaiting email retry')
          },
        }),
      ),
    { concurrency: 2, discard: true },
  )
}

export class CloudWorkspace {
  private readonly runtime: ReturnType<typeof openRuntime>
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: CloudEnvironment,
    options: { r2Endpoint?: string } = {},
  ) {
    this.runtime = openRuntime(state, env, options.r2Endpoint)
  }

  async alarm() {
    const { env, state } = this
    await this.runtime.runPromise(
      Effect.gen(function* () {
        const { catalog, r2 } = yield* WorkspaceServices
        const claims = catalog.claimCleanup(Date.now())
        yield* Effect.forEach(
          claims,
          (claim) =>
            attempt(() => cleanupFile(catalog, r2, claim)).pipe(
              Effect.catch(() =>
                Effect.sync(() =>
                  console.error('lshare storage cleanup awaiting retry'),
                ),
              ),
            ),
          { concurrency: 4, discard: true },
        )
        yield* deliverAlerts(catalog, env)
        if (claims.length === 25)
          yield* attempt(() => state.storage.setAlarm(Date.now() + 1000))
      }),
    )
  }

  async fetch(request: Request) {
    const path = new URL(request.url).pathname
    try {
      if (path === '/internal/maintenance' && request.method === 'POST') {
        await this.alarm()
        return new Response(null, { status: 204 })
      }
      const result = await this.runtime.runPromiseExit(
        Effect.flatMap(WorkspaceServices, (services) =>
          attempt(() => cloudApi(request, this.env, services)),
        ),
      )
      if (Exit.isFailure(result)) throw Cause.squash(result.cause)
      return result.value
    } catch (error) {
      return errorResponse(error)
    } finally {
      if (request.method === 'POST' && path === '/api/transfers/uploads')
        this.state.waitUntil(
          this.runtime.runPromise(
            Effect.flatMap(WorkspaceServices, (s) =>
              deliverAlerts(s.catalog, this.env),
            ),
          ),
        )
    }
  }
}

function loopback(url: URL) {
  return (
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
}
function protectedResponse(response: Response, storageOrigin: string) {
  const result = new Response(response.body, response)
  const headers = result.headers
  headers.set(
    'Referrer-Policy',
    headers.get('Content-Type')?.startsWith('text/html')
      ? 'same-origin'
      : 'no-referrer',
  )
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self'",
      "connect-src 'self' " + storageOrigin,
      "form-action 'self' " + storageOrigin,
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  )
  return result
}
const assets = new Set([
  'cloud.css',
  'cloud.js',
  'transfer-client.js',
  'lshare-folio.webp',
  'lshare-mark.png',
])
export function workspace(env: CloudEnvironment) {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName('lshare-v1'))
}

export function createCloudWorker(fixtureStorageOrigin?: string) {
  return {
    async fetch(request: Request, env: CloudEnvironment): Promise<Response> {
      const url = new URL(request.url)
      let storageOrigin = ''
      try {
        if (
          url.origin !== env.PUBLIC_ORIGIN ||
          (url.protocol !== 'https:' && !loopback(url))
        )
          throw new TransferError(421, 'Incorrect application origin.')
        if (
          !/^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID) ||
          (env.R2_JURISDICTION &&
            !['eu', 'fedramp'].includes(env.R2_JURISDICTION))
        )
          throw new Error('Invalid storage configuration')
        storageOrigin =
          'https://' +
          env.R2_ACCOUNT_ID +
          (env.R2_JURISDICTION ? '.' + env.R2_JURISDICTION : '') +
          '.r2.cloudflarestorage.com'
        if (fixtureStorageOrigin) {
          const fixture = new URL(fixtureStorageOrigin)
          if (
            !loopback(fixture) ||
            !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          )
            throw new Error('Invalid fixture endpoint')
          storageOrigin = fixture.origin
        }

        if (url.pathname.startsWith('/api/')) {
          const write = request.method === 'POST' || request.method === 'DELETE'
          if (!write && request.method !== 'GET')
            throw new TransferError(405, 'Unsupported metadata method.')
          if (
            write &&
            (request.headers.get('Origin') !== env.PUBLIC_ORIGIN ||
              request.headers.get('Sec-Fetch-Site') === 'cross-site')
          )
            throw new TransferError(403, 'Same-origin request required.')
          // Only the browser follows signed downloads. Following here could proxy object bytes.
          const init: RequestInit = {
            method: request.method,
            headers: request.headers,
            redirect: 'manual',
          }
          if (request.method === 'POST') {
            const type = request.headers
              .get('Content-Type')
              ?.split(';')[0]
              ?.trim()
              .toLowerCase()
            if (
              type !== 'application/json' &&
              !(
                type === 'application/x-www-form-urlencoded' &&
                /^\/api\/links\/[^/]+\/download$/.test(url.pathname)
              )
            )
              throw new TransferError(415, 'Expected transfer metadata.')
            init.body = await controlText(request)
          } else if (request.body) {
            await controlText(request, 0)
          }
          const response = await workspace(env).fetch(
            new Request(request.url, init),
          )
          let control = response
          if (response.status === 303 || response.status === 204) {
            // A workerd binding may represent an empty redirect body with a stream.
            await response.body?.cancel()
            if (response.status === 303) {
              const location = response.headers.get('Location')
              if (!location)
                throw new TransferError(502, 'Missing transfer destination.')
              const destination = new URL(location, url)
              if (
                destination.origin !== storageOrigin &&
                destination.origin !== url.origin
              )
                throw new TransferError(502, 'Invalid transfer destination.')
            }
            control = new Response(null, response)
          } else if (
            response.headers.get('Content-Type')?.split(';')[0] !==
            'application/json'
          ) {
            await response.body?.cancel()
            throw new TransferError(502, 'Invalid metadata response.')
          }
          const secured = protectedResponse(control, storageOrigin)
          secured.headers.set('Cache-Control', 'no-store')
          return secured
        }

        if (!['GET', 'HEAD'].includes(request.method))
          throw new TransferError(405, 'Unsupported method.')
        if (
          url.pathname.startsWith('/assets/') &&
          assets.has(url.pathname.slice('/assets/'.length))
        )
          return protectedResponse(
            await env.ASSETS.fetch(request),
            storageOrigin,
          )
        const link = /^\/(s|r)\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
        let page: Response
        if (url.pathname === '/') page = renderCloudPage('home')
        else if (link)
          page = renderCloudPage(link[1] === 's' ? 'share' : 'request', link[2])
        else throw new TransferError(404, 'Page not found.')
        return protectedResponse(
          request.method === 'HEAD' ? new Response(null, page) : page,
          storageOrigin,
        )
      } catch (error) {
        const response = protectedResponse(errorResponse(error), storageOrigin)
        response.headers.set('Cache-Control', 'no-store')
        return response
      }
    },
    async scheduled(_event: ScheduledController, env: CloudEnvironment) {
      const result = await workspace(env).fetch(
        'https://internal/internal/maintenance',
        { method: 'POST' },
      )
      if (!result.ok) throw new Error('Storage maintenance failed')
    },
  }
}

export default createCloudWorker()
