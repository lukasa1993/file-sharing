import {
  controlJson,
  controlText,
  transferApi,
  TransferError,
} from '../shared/transfers.ts'
import type { CloudCatalog } from './catalog.ts'
import type { CloudIdentity, CloudUser } from './identity.ts'
import type { CloudMailEnv } from './mail.ts'
import type { R2Transfers } from './r2.ts'
import { ownerShareApi } from '../shared/shares.ts'
import type { CloudSharing, CloudShare } from './sharing.ts'
import { CloudTransferAdapter } from './transfers.ts'

export type CloudApiServices = {
  identity: CloudIdentity
  sharing: CloudSharing
  catalog: CloudCatalog
  r2: R2Transfers
}

const missing = () => new TransferError(404, 'Link unavailable.')
const invalid = (message: string) => new TransferError(400, message)
const responseHeaders = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
}
function redirect(location: string) {
  return new Response(null, {
    status: 303,
    headers: { ...responseHeaders, Location: location },
  })
}
function methods(allow: string) {
  return Response.json(
    { error: 'Method unavailable.' },
    { status: 405, headers: { ...responseHeaders, Allow: allow } },
  )
}
function requireUser(user: CloudUser | null) {
  if (!user) throw new TransferError(401, 'Sign in with a verified account.')
  return user
}
function allowedFields(
  fields: Record<string, unknown>,
  allowed: readonly string[],
) {
  if (Object.keys(fields).some((key) => !allowed.includes(key)))
    throw invalid('Unexpected metadata field.')
}
function portableShare(link: CloudShare) {
  const prefix = link.kind === 'request' ? '/r/' : '/s/'
  return { ...link, href: prefix + encodeURIComponent(link.alias) }
}

async function linkPassword(request: Request, native: boolean) {
  if (native) {
    const fields = new URLSearchParams(await controlText(request, 4096))
    if (
      [...fields.keys()].some((name) => name !== 'password') ||
      fields.getAll('password').length !== 1
    )
      throw invalid('Enter the share password.')
    return fields.get('password')
  }
  const fields = await controlJson(request)
  allowedFields(fields, ['password'])
  if (typeof fields.password !== 'string')
    throw invalid('Enter the share password.')
  return fields.password
}

async function recipientRoute(
  request: Request,
  alias: string,
  download: boolean,
  services: CloudApiServices,
  user: CloudUser | null,
  peer: string | undefined,
) {
  const { sharing, catalog, r2, identity } = services
  const meta = sharing.recipient(alias)
  if (!download) {
    if (request.method !== 'GET') return methods('GET')
    const authorized =
      meta.access === 'public' || (meta.access === 'verified' && user !== null)
    if (!authorized || meta.kind === 'request') {
      if (authorized && meta.kind === 'request')
        sharing.authorizeUpload(alias, user)
      return Response.json(
        { ...meta, authorized },
        { headers: responseHeaders },
      )
    }
    const { name, size, expiresAt } = await sharing.authorizeDownload(
      alias,
      user,
    )
    return Response.json(
      { ...meta, authorized, name, size, expiresAt },
      { headers: responseHeaders },
    )
  }
  if (meta.kind !== 'file') throw missing()
  const method = request.method
  if (method !== 'GET' && (method !== 'POST' || meta.access !== 'password'))
    return methods(meta.access === 'password' ? 'GET, POST' : 'GET')
  const native =
    method === 'POST' &&
    request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ===
      'application/x-www-form-urlencoded'
  const password =
    method === 'POST' ? await linkPassword(request, native) : null
  let grant: Awaited<ReturnType<CloudSharing['authorizeDownload']>>
  try {
    grant = await sharing.authorizeDownload(
      alias,
      user,
      password,
      undefined,
      peer,
    )
  } catch (error) {
    if (
      native &&
      error instanceof TransferError &&
      [401, 403, 429].includes(error.status)
    )
      return redirect(
        '/s/' +
          alias +
          '?error=' +
          (error.status === 429 ? 'try-later' : 'password'),
      )
    throw error
  }
  const file = catalog.ready(grant.fileId, Date.now())
  if (!file || file.ownerId !== grant.ownerId) throw missing()
  const expiresAt = Math.min(file.expiresAt, grant.expiresAt)
  if (Math.floor(expiresAt / 1000) <= Math.floor(Date.now() / 1000))
    throw missing()
  const location = await r2.download(file.key, expiresAt)
  // Signing is asynchronous. Check the link, current session and representation again before returning the URL.
  if (
    meta.access === 'verified' &&
    (await identity.current(request))?.id !== user?.id
  )
    throw new TransferError(401, 'Sign in with a verified account.')
  sharing.recipient(alias)
  const current = catalog.ready(file.id, Date.now())
  if (
    !current ||
    current.ownerId !== file.ownerId ||
    current.key !== file.key ||
    current.expiresAt < expiresAt ||
    Date.now() >= expiresAt
  )
    throw missing()
  return redirect(location)
}

export async function cloudApi(
  request: Request,
  env: CloudMailEnv,
  services: CloudApiServices,
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const path = url.pathname
    const peer = request.headers.get('CF-Connecting-IP')?.slice(0, 128)
    if (path.startsWith('/api/auth/'))
      return await services.identity.handle(request, env, peer)
    const actor = await services.identity.current(request)
    if (path.startsWith('/api/transfers/')) {
      const adapter = new CloudTransferAdapter(
        services.catalog,
        services.r2,
        services.sharing,
        requireUser(actor),
      )
      return await transferApi(request, adapter)
    }
    if (path === '/api/shares' || path.startsWith('/api/shares/')) {
      const owner = requireUser(actor)
      return await ownerShareApi(request, {
        list: () => services.sharing.list(owner).map(portableShare),
        create: async ({ target, confirmPublic, ...input }) => {
          if (target !== undefined)
            throw invalid('Cloud upload requests have no storage folder.')
          if (
            confirmPublic === false &&
            (input.access === 'public' ||
              (input.kind === 'file' && !input.access))
          )
            throw invalid('Confirm public access to this link.')
          return portableShare(await services.sharing.create(owner, input))
        },
        revoke: (id) => services.sharing.revoke(owner, id),
      })
    }
    const link = /^\/api\/links\/([a-z0-9][a-z0-9_-]{0,63})(\/download)?$/.exec(
      path,
    )
    if (link?.[1]) {
      if (url.search) throw invalid('Use the link without query parameters.')
      return await recipientRoute(
        request,
        link[1],
        !!link[2],
        services,
        actor,
        peer,
      )
    }
    throw new TransferError(404, 'Page not found.')
  } catch (error) {
    if (!(error instanceof TransferError)) throw error
    return Response.json(
      { error: error.message },
      { status: error.status, headers: responseHeaders },
    )
  }
}
