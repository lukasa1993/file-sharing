import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRouter } from 'remix/router'
import { route } from 'remix/routes'
import { cop } from 'remix/middleware/cop'
import { csp } from 'remix/middleware/csp'
import { Stream } from 'effect'
import {
  actions,
  AppError,
  defaultBrand,
  type Entry,
  type ResourceRef,
  type User,
} from './contracts.ts'
import { adminUser, data, go, mustUser, ownerGuard, localNext } from './http.ts'
import { inspectFile } from './inspection/index.ts'
import { requestRef, resource, selected } from './metadata.ts'
import { handleFileOperation } from './operations.ts'
import type { Services } from './runtime.ts'
import type { Access } from './identity/index.ts'
import {
  changeDirectoryPermission,
  directoryPermissions,
} from './identity/directory-permissions.ts'
import { renderDirectoryPermissions } from './ui/directory-permissions.tsx'
import { BunTransferAdapter, bunUploadAccess } from './transfers/adapter.ts'
import { ownerShareApi } from '../shared/shares.ts'
import { BunShareAdapter } from './shares/adapter.ts'
import { transferApi } from '../shared/transfers.ts'
import {
  renderLogin,
  renderProviderRedirect,
  renderFiles,
  renderTrash,
  renderAdmin,
  renderAccount,
  renderShares,
} from './ui/index.tsx'
import { buildUiAssets } from './ui/assets.ts'
import { refUrl } from './ui/base.tsx'

const routes = route({
  home: '/',
  login: '/login',
  oidcStart: '/_/auth/oidc',
  oidcCallback: '/_/auth/oidc/callback',
  logout: '/logout',
  files: '/_/files',
  directoryPermissions: '/_/folder-permissions',
  shares: '/_/shares',
  trash: '/_/trash',
  admin: '/_/admin',
  account: '/_/account',
  entries: '/_/api/v1/entries',
  operations: '/_/api/v1/files/operations',
  settings: '/_/api/v1/admin',
  diagnostics: '/_/api/v1/admin/diagnostics',
  profile: '/_/api/v1/account',
  preferences: '/_/api/v1/preferences',
  shareCollection: '/_/api/v1/shares',
  shareItem: '/_/api/v1/shares/:id',
  unlock: '/_/shares/:id/unlock',
  download: '/_/download',
  preview: '/_/preview',
  inspect: '/_/inspect',
  archive: '/_/archive',
  uploads: '/_/uploads',
  upload: '/_/uploads/:id',
  ownerShares: '/api/shares',
  ownerShare: '/api/shares/:id',
  transferFiles: '/api/transfers/files',
  transferFile: '/api/transfers/files/:id',
  transferDownload: '/api/transfers/files/:id/download',
  transferUploads: '/api/transfers/uploads',
  transferUpload: '/api/transfers/uploads/:id',
  transferParts: '/api/transfers/uploads/:id/parts',
  transferComplete: '/api/transfers/uploads/:id/complete',
  events: '/_/events',
  health: '/healthz',
  ready: '/readyz',
  assets: '/assets/:name.:extension',
  workspaceIcon: '/assets/workspace-icon',
})
type Endpoint = { request: Request; url: URL }
const safe = new Set(['GET', 'HEAD', 'OPTIONS'])
const reserved = new Set([
  '_',
  'admin',
  'api',
  'assets',
  'login',
  'logout',
  'healthz',
  'readyz',
  'robots.txt',
  'favicon.ico',
  '.well-known',
])
export type RequestAudit = { peer?: string; actorId?: string }
function orderEntries(entries: Entry[], sort: string) {
  const strings = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base',
  })
  const dir = sort.endsWith('-desc') ? -1 : 1,
    field = sort.replace(/-desc$/, '')
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    let difference = 0
    if (field === 'size') difference = a.size - b.size
    else if (field === 'mtime' || field === 'modifiedAt')
      difference = a.modifiedAt.localeCompare(b.modifiedAt)
    else if (field === 'type')
      difference = strings.compare(
        a.name.split('.').at(-1) || '',
        b.name.split('.').at(-1) || '',
      )
    else difference = strings.compare(a.name, b.name)
    return dir * difference || strings.compare(a.name, b.name)
  })
}
export async function appRouter(
  s: Services,
  audit: WeakMap<Request, RequestAudit>,
) {
  const assets = await buildUiAssets()
  const dir = new URL('../public/', import.meta.url)
  for (const file of await readdir(dir, { withFileTypes: true })) {
    if (
      file.isFile() &&
      /^[a-z0-9-]+\.(css|js|png|svg|webp|woff2)$/.test(file.name)
    ) {
      const asset = Bun.file(fileURLToPath(new URL(file.name, dir)))
      assets.set(
        file.name,
        new Blob([await asset.arrayBuffer()], { type: asset.type }),
      )
    }
  }
  let workspaceIcon = assets.get('lshare-mark.png')
  if (!workspaceIcon) throw new Error('Missing workspace icon asset')
  if (s.config.brandIcon) {
    const image = new Bun.Image(s.config.brandIcon, { maxPixels: 512 * 512 })
    const { format, width, height } = await image.metadata()
    if (format !== 'png' || width > 512 || height > 512)
      throw new Error('BRAND_ICON_FILE requires a PNG up to 512 × 512 pixels')
    workspaceIcon = new Blob([Uint8Array.from(await image.png().bytes())], {
      type: 'image/png',
    })
  }
  const sessions = new WeakMap<Request, Access>()
  function access(ctx: Endpoint): Access {
    const value = sessions.get(ctx.request)
    if (!value) throw new AppError(500, 'Request context unavailable')
    return value
  }
  const router = createRouter({
    middleware: [
      cop(),
      csp({
        policy: {
          defaultSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'blob:'],
          mediaSrc: ["'self'"],
          connectSrc: ["'self'"],
        },
      }),
      async (ctx, next) => {
        const { request, url } = ctx
        if (
          url.pathname.startsWith('/assets/') ||
          url.pathname === '/healthz' ||
          url.pathname === '/readyz'
        )
          return next()
        const publicPath = !url.pathname.startsWith('/_/')
        const needSession =
          request.method === 'GET' &&
          !url.pathname.startsWith('/api/') &&
          (publicPath || !url.pathname.startsWith('/_/api/')) &&
          !['/_/download', '/_/preview', '/_/archive', '/_/events'].includes(
            url.pathname,
          )
        const access = await s.identity.context(request, needSession)
        sessions.set(request, access)
        const record = audit.get(request)
        if (record && access.user) record.actorId = access.user.id
        if (!safe.has(request.method))
          await s.identity.verifyWrite(request, access)
        const response = await next()
        if (access.setCookie && !response.headers.has('Set-Cookie'))
          response.headers.append('Set-Cookie', access.setCookie)
        return response
      },
    ],
    defaultHandler: async (ctx) => {
      const first = ctx.url.pathname.split('/')[1] || ''
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(first) || reserved.has(first))
        throw new AppError(404, 'Page not found')
      if (!['GET', 'HEAD'].includes(ctx.request.method))
        throw new AppError(405, 'Method unavailable')
      return s.shares.public(ctx.request, access(ctx), brand())
    },
  })
  const current = (ctx: Endpoint) => mustUser(access(ctx))
  const brand = () => s.meta.value('brand', defaultBrand)
  function mounts(user: User) {
    return s.config.mounts
      .filter(
        (m) =>
          user.admin ||
          s.identity.allowed(user, 'list', { mountId: m.id, segments: [] }),
      )
      .map((m) => ({
        id: m.id,
        label: s.meta.value('mount:' + m.id, m.label),
        readOnly: m.readOnly,
        available: s.fs.isEnabled(m.id),
      }))
  }
  function shell(ctx: Endpoint) {
    const user = current(ctx)
    if (access(ctx).bearer)
      throw new AppError(403, 'Open this page in a signed-in browser')
    const home = s.identity.home(user)
    return {
      user,
      csrf: access(ctx).csrf,
      brand: brand(),
      ...s.meta.displayPreferences(user.id),
      mounts: mounts(user),
      ...(home ? { home } : {}),
    }
  }
  const toFiles = (ref: ResourceRef) => refUrl('/_/files', ref)
  router.get(routes.home, (ctx) => {
    const user = access(ctx).user
    if (!user) return go('/login')
    const home = s.identity.home(user)
    if (home) return go(toFiles(home))
    return go('/_/files')
  })
  router.get(routes.login, (ctx) =>
    access(ctx).user
      ? go('/')
      : renderLogin({
          csrf: access(ctx).csrf,
          oidc: Boolean(s.config.oidc),
          next: localNext(ctx.url.searchParams.get('next')),
          ...(ctx.url.searchParams.has('providerError')
            ? {
                providerError: true,
                error:
                  'Could not sign in with the identity provider. Try again or use your local account.',
              }
            : {}),
          brand: brand(),
        }),
  )
  router.post(routes.login, async (ctx) => {
    const fields = await data(ctx.request)
    if (
      typeof fields.username !== 'string' ||
      typeof fields.password !== 'string'
    )
      throw new AppError(400, 'Enter your username and password')
    const next = localNext(fields.next)
    try {
      const cookie = await s.identity.login(
        ctx.request,
        access(ctx),
        fields.username,
        fields.password,
        audit.get(ctx.request)?.peer,
      )
      const response = go(next)
      response.headers.append('Set-Cookie', cookie)
      return response
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 401) throw error
      const page = await renderLogin({
        csrf: access(ctx).csrf,
        oidc: Boolean(s.config.oidc),
        error: error.message,
        next,
        brand: brand(),
      })
      return new Response(page.body, { status: 401, headers: page.headers })
    }
  })
  router.post(routes.oidcStart, async (ctx) => {
    const fields = await data(ctx.request)
    const next = localNext(fields.next)
    try {
      const result = await s.identity.startOidc(
        ctx.request,
        access(ctx),
        next,
        audit.get(ctx.request)?.peer,
      )
      const location = result.headers.get('Location')
      if (!location) throw new AppError(503, 'Identity provider unavailable.')
      return renderProviderRedirect(location, brand())
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 503) throw error
      const page = await renderLogin({
        csrf: access(ctx).csrf,
        oidc: true,
        providerError: true,
        error: error.message,
        next,
        brand: brand(),
      })
      return new Response(page.body, { status: 503, headers: page.headers })
    }
  })
  router.get(routes.oidcCallback, async (ctx) => {
    if (!s.config.oidc) throw new AppError(404, 'Provider unavailable.')
    let response: Response
    try {
      const loggedIn = await s.identity.finishOidc(ctx.request, access(ctx))
      response = go(localNext(loggedIn.next))
      response.headers.set('Set-Cookie', loggedIn.cookie)
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) throw error
      response = go('/login?providerError=1')
    }
    response.headers.set('Referrer-Policy', 'no-referrer')
    return response
  })
  router.post(routes.logout, async (ctx) => {
    const response = go('/login')
    response.headers.append('Set-Cookie', await s.identity.logout(access(ctx)))
    return response
  })
  router.get(routes.health, () => Response.json({ status: 'ok' }))
  router.get(routes.ready, async () => {
    const roots = s.config.mounts.filter((m) => s.fs.isEnabled(m.id))
    const statuses = await Promise.allSettled(
      roots.map((m) => s.fs.space(m.id)),
    )
    s.db.query('SELECT 1').get()
    return statuses.some((x) => x.status === 'fulfilled')
      ? Response.json({ status: 'ready' })
      : Response.json({ status: 'unavailable' }, { status: 503 })
  })
  router.get(
    routes.workspaceIcon,
    () =>
      new Response(workspaceIcon, {
        headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' },
      }),
  )
  router.get(routes.assets, (ctx) => {
    const asset = assets.get(`${ctx.params.name}.${ctx.params.extension}`)
    if (!asset) throw new AppError(404, 'Asset not found')
    return new Response(asset, {
      headers: {
        'Content-Type': asset.type || 'application/octet-stream',
        'Cache-Control': 'public, max-age=0, must-revalidate',
      },
    })
  })
  router.get(routes.files, async (ctx) => {
    const workspace = shell(ctx)
    const guard = ownerGuard(s, workspace.user)
    const entryPoints: ResourceRef[] = []
    for (const candidate of s.identity.entryPoints(workspace.user)) {
      if (
        !candidate.segments.length ||
        !s.fs.isEnabled(candidate.mountId) ||
        (workspace.home && toFiles(candidate) === toFiles(workspace.home))
      )
        continue
      try {
        if ((await s.fs.stat(candidate, guard)).kind === 'directory')
          entryPoints.push(candidate)
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          ![403, 404, 503].includes(error.status)
        )
          throw error
      }
    }
    const model = { ...workspace, entryPoints }
    const firstMount = model.mounts[0]
    const fallback = model.home ||
      (firstMount
        ? { mountId: firstMount.id, segments: [] }
        : entryPoints[0]) || { mountId: '', segments: [] }
    const ref = ctx.url.searchParams.has('mount')
      ? requestRef(ctx.url)
      : fallback
    if (!ref.mountId)
      return renderFiles({
        ...model,
        ref,
        entries: [],
        permissions: [],
        error: 'No storage folders have been assigned to your account.',
      })
    guard('list', ref)
    const mount = s.config.mounts.find((m) => m.id === ref.mountId)
    if (!mount) throw new AppError(404, 'Storage root unavailable')
    const currentMount = {
      id: mount.id,
      label: s.meta.value('mount:' + mount.id, mount.label),
      available: s.fs.isEnabled(mount.id),
      readOnly: mount.readOnly,
    }
    const query = (ctx.url.searchParams.get('q') || '').trim().slice(0, 256)
    const scope =
      ctx.url.searchParams.get('scope') === 'tree' ? 'tree' : 'folder'
    try {
      let entries =
        scope === 'tree' && query
          ? await s.fs.search(
              ref,
              query,
              guard,
              model.user.id,
              ctx.request.signal,
            )
          : await s.fs.list(ref, guard)
      if (query && scope !== 'tree')
        entries = entries.filter((e) =>
          e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        )
      orderEntries(entries, model.sort)
      const size = 100,
        page = Math.max(
          1,
          Math.min(
            Number.parseInt(ctx.url.searchParams.get('page') || '1', 10) || 1,
            Math.ceil(entries.length / size) || 1,
          ),
        )
      const view = entries.slice((page - 1) * size, page * size).map((e) => ({
        ...e,
        permissions: actions.filter((a) =>
          s.identity.allowed(model.user, a, e.ref),
        ),
      }))
      s.meta.bookmark(model.user.id, 'recents', ref)
      return renderFiles({
        ...model,
        currentMount,
        ref,
        entries: view,
        scope,
        query,
        permissions: actions.filter((a) =>
          s.identity.allowed(model.user, a, ref),
        ),
        pagination: { page, pages: Math.ceil(entries.length / size) },
        space: await s.fs.space(ref.mountId),
      })
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 503) throw error
      const page = await renderFiles({
        ...model,
        ref,
        entries: [],
        permissions: [],
        error:
          'This storage root is unavailable. Contact the host to reconnect it.',
      })
      return new Response(page.body, { status: 503, headers: page.headers })
    }
  })
  router.get(routes.entries, async (ctx) =>
    Response.json(
      await s.fs.list(requestRef(ctx.url), ownerGuard(s, current(ctx))),
    ),
  )
  async function directoryContext(ctx: Endpoint) {
    const model = shell(ctx)
    const ref = requestRef(ctx.url)
    const guard = ownerGuard(s, model.user)
    guard('manage', ref)
    const entry = await s.fs.stat(ref, guard, 'manage')
    if (entry.kind !== 'directory') throw new AppError(400, 'Select a folder.')
    return { model, ref }
  }
  router.get(routes.directoryPermissions, async (ctx) => {
    const { model, ref } = await directoryContext(ctx)
    return renderDirectoryPermissions(
      model,
      ref,
      directoryPermissions(s.identity, model.user, ref),
    )
  })
  router.post(routes.directoryPermissions, async (ctx) => {
    const { model, ref } = await directoryContext(ctx)
    changeDirectoryPermission(
      s.identity,
      model.user,
      ref,
      await data(ctx.request),
    )
    return go(refUrl('/_/folder-permissions', ref))
  })
  router.post(routes.operations, async (ctx) => {
    const user = current(ctx)
    return handleFileOperation(
      s.fs,
      s.transfers,
      await data(ctx.request),
      ownerGuard(s, user),
      user.id,
      ctx.request,
    )
  })
  router.get(routes.trash, (ctx) =>
    renderTrash({
      ...shell(ctx),
      items: s.fs.trash(ownerGuard(s, current(ctx))),
    }),
  )
  router.get(routes.shares, (ctx) => {
    const model = shell(ctx)
    return renderShares({
      ...model,
      shares: s.shares.list(model.user),
      ...(model.user.admin
        ? { owners: s.identity.listShareOwners(model.user) }
        : {}),
    })
  })
  function accountPage(ctx: Endpoint, issuedToken?: string) {
    const user = current(ctx)
    const quota = s.identity.quota(user.id)
    const usage = s.transfers.quotaUsage(user.id)[0]
    return renderAccount({
      ...shell(ctx),
      data: s.identity.userData(user),
      quota,
      used: usage?.used ?? 0,
      reserved: usage?.reserved ?? 0,
      bandwidth: s.identity.bandwidthBudget(user.id).rate(),
      ...(issuedToken ? { issuedToken } : {}),
    })
  }
  router.get(routes.account, (ctx) => accountPage(ctx))
  const updateAccount = async (ctx: Endpoint, native: boolean) => {
    const user = current(ctx)
    const result = await s.identity.self(user, await data(ctx.request))
    if (!native) return Response.json(result)
    if (result.token) return accountPage(ctx, result.token)
    return go('/_/account')
  }
  router.post(routes.account, (ctx) => updateAccount(ctx, true))
  router.post(routes.profile, (ctx) => updateAccount(ctx, false))
  router.get(routes.preferences, (ctx) =>
    Response.json(
      s.meta.preferences(current(ctx).id, ownerGuard(s, current(ctx))),
    ),
  )
  router.post(routes.preferences, async (ctx) =>
    Response.json(
      s.meta.updatePreferences(
        current(ctx).id,
        await data(ctx.request),
        ownerGuard(s, current(ctx)),
      ),
    ),
  )
  const shareOwner = (ctx: Endpoint) =>
    s.shares.owner(ctx.request, current(ctx))
  router.get(routes.shareCollection, shareOwner)
  router.post(routes.shareCollection, shareOwner)
  router.get(routes.shareItem, shareOwner)
  router.post(routes.shareItem, shareOwner)
  router.patch(routes.shareItem, shareOwner)
  router.delete(routes.shareItem, shareOwner)
  router.post(routes.unlock, (ctx) =>
    s.shares.public(
      ctx.request,
      access(ctx),
      brand(),
      audit.get(ctx.request)?.peer,
    ),
  )
  const transferOptions = (user: User) => ({
    actor: user.id,
    bandwidthBudgets: [s.identity.bandwidthBudget(user.id)],
  })
  const download = (ctx: Endpoint) =>
    s.transfers.download(
      ctx.request,
      requestRef(ctx.url),
      ownerGuard(s, current(ctx)),
      transferOptions(current(ctx)),
    )
  const preview = (ctx: Endpoint) =>
    s.transfers.preview(
      ctx.request,
      requestRef(ctx.url),
      ownerGuard(s, current(ctx)),
      transferOptions(current(ctx)),
    )
  router.get(routes.download, download)
  router.head(routes.download, download)
  router.get(routes.preview, preview)
  router.head(routes.preview, preview)
  const inspect = (ctx: Endpoint) =>
    inspectFile(
      ctx.request,
      requestRef(ctx.url),
      ownerGuard(s, current(ctx)),
      s.fs,
      s.transfers.contentPolicy.current,
    )
  router.get(routes.inspect, inspect)
  router.head(routes.inspect, inspect)
  router.put(routes.preview, (ctx) =>
    s.transfers.editText(
      ctx.request,
      requestRef(ctx.url),
      ownerGuard(s, current(ctx)),
    ),
  )
  router.get(routes.archive, (ctx) => {
    const refs = ctx.url.searchParams.getAll('ref').map((value) => {
      try {
        return resource(JSON.parse(value))
      } catch {
        throw new AppError(400, 'Invalid archive selection')
      }
    })
    return s.transfers.archive(
      ctx.request,
      refs.length ? selected(refs) : [requestRef(ctx.url)],
      ownerGuard(s, current(ctx)),
      transferOptions(current(ctx)),
    )
  })
  const ownerShares = (ctx: Endpoint) =>
    ownerShareApi(ctx.request, new BunShareAdapter(s, current(ctx)))
  router.get(routes.ownerShares, ownerShares)
  router.post(routes.ownerShares, ownerShares)
  router.delete(routes.ownerShare, ownerShares)
  const commonTransfer = (ctx: Endpoint) =>
    transferApi(
      ctx.request,
      new BunTransferAdapter(s, ctx.request, access(ctx)),
    )
  router.get(routes.transferFiles, commonTransfer)
  router.delete(routes.transferFile, commonTransfer)
  router.get(routes.transferDownload, commonTransfer)
  router.post(routes.transferUploads, commonTransfer)
  router.post(routes.transferParts, commonTransfer)
  router.post(routes.transferComplete, commonTransfer)
  router.delete(routes.transferUpload, commonTransfer)
  async function uploads(ctx: Endpoint, id?: string) {
    const actor = await bunUploadAccess(
      s,
      access(ctx),
      ctx.url.searchParams.get('share'),
    )
    const response = await s.transfers.upload(ctx.request, actor, id)
    response.headers.set(
      'Fileserver-Max-Chunk-Bytes',
      String(s.transfers.limits.maxChunkBytes),
    )
    return response
  }
  router.options(routes.uploads, (ctx) => uploads(ctx))
  router.post(routes.uploads, (ctx) => uploads(ctx))
  router.options(routes.upload, (ctx) => uploads(ctx, ctx.params.id))
  router.head(routes.upload, (ctx) => uploads(ctx, ctx.params.id))
  router.patch(routes.upload, (ctx) => uploads(ctx, ctx.params.id))
  router.delete(routes.upload, (ctx) => uploads(ctx, ctx.params.id))
  router.get(routes.events, (ctx) => {
    const user = current(ctx)
    const stream = Stream.fromPubSub(s.events).pipe(
      Stream.takeWhile(() => s.identity.isCurrent(user)),
      Stream.map((items) => {
        const admin = s.identity.getUser(user.id)?.admin
        return (
          'event: transfers\ndata: ' +
          JSON.stringify(items.filter((t) => admin || t.actor === user.id)) +
          '\n\n'
        )
      }),
      Stream.encodeText,
      Stream.toReadableStream,
    )
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    })
  })
  router.get(routes.admin, async (ctx) => {
    const user = adminUser(s, access(ctx))
    const states = await Promise.all(
      mounts(user).map(async (mount) => {
        const retentionMs = s.fs.trashRetention(mount.id)
        try {
          return {
            ...mount,
            retentionMs,
            ...(await s.fs.space(mount.id)),
            available: true,
          }
        } catch (error) {
          if (!(error instanceof AppError) || error.status !== 503) throw error
          return { ...mount, retentionMs, available: false }
        }
      }),
    )
    return renderAdmin({
      ...shell(ctx),
      runtime: {
        version: Bun.version,
        platform: process.platform,
        architecture: process.arch,
        limits: s.transfers.limits,
      },
      contentLimits: s.transfers.contentPolicy.current,
      retentionDays: Number(s.meta.value('trashRetentionDays', '30')),
      data: {
        ...s.identity.adminData(user),
        quotaUsage: s.transfers.quotaUsage(),
        mounts: states,
        transfers: s.transfers.active(),
        activity: s.meta.activity(),
      },
    })
  })
  router.get(routes.diagnostics, (ctx) => {
    adminUser(s, access(ctx))
    const active = s.transfers.active()
    return Response.json(
      {
        bun: Bun.version,
        platform: process.platform,
        architecture: process.arch,
        uptimeSeconds: Math.floor(process.uptime()),
        residentBytes: process.memoryUsage.rss(),
        counters: s.counters(),
        activeTransfers: active.length,
        transferBytesPerSecond: active.reduce(
          (sum, transfer) => sum + transfer.bytesPerSecond,
          0,
        ),
      },
      {
        headers: {
          'Content-Disposition':
            'attachment; filename="lshare-diagnostics.json"',
        },
      },
    )
  })
  const updateAdmin = async (ctx: Endpoint, native: boolean) => {
    const user = adminUser(s, access(ctx)),
      fields = await data(ctx.request)
    if (native) {
      if (typeof fields.principal === 'string') {
        const [type, id] = fields.principal.split(':')
        fields.subjectType = type
        fields.subjectId = id
      }
      if (fields.enabled === 'keep') delete fields.enabled
      else if (fields.enabled === 'true' || fields.enabled === 'false')
        fields.enabled = fields.enabled === 'true'
      for (const key of ['brand', 'label', 'trashRetentionDays'])
        if (fields[key] === '') delete fields[key]
      if (fields.retentionDays === '') fields.retentionDays = null
    }
    switch (fields.action) {
      case 'cancelTransfer':
        if (typeof fields.id !== 'string' || !s.transfers.cancel(fields.id))
          throw new AppError(404, 'Transfer finished or unavailable')
        break
      case 'setMount': {
        const id = fields.mountId
        if (typeof id !== 'string' || !s.config.mounts.some((m) => m.id === id))
          throw new AppError(400, 'Unknown storage root')
        if (
          fields.label !== undefined &&
          (typeof fields.label !== 'string' ||
            !fields.label.trim() ||
            fields.label.length > 128)
        )
          throw new AppError(400, 'Invalid storage label')
        if (fields.enabled !== undefined && typeof fields.enabled !== 'boolean')
          throw new AppError(400, 'Invalid storage state')
        if (fields.retentionDays !== undefined) {
          const days = Number(fields.retentionDays)
          if (
            fields.retentionDays !== null &&
            (!Number.isInteger(days) || days < 1 || days > 3650)
          )
            throw new AppError(400, 'Invalid retention period')
          s.fs.setTrashRetention(
            id,
            fields.retentionDays === null ? null : days * 86400000,
          )
        }
        if (typeof fields.enabled === 'boolean')
          s.fs.setEnabled(id, fields.enabled)
        if (typeof fields.label === 'string')
          s.meta.set('mount:' + id, fields.label.trim())
        break
      }
      case 'setContentLimits':
        s.transfers.contentPolicy.update(fields)
        s.identity.audit(user.id, 'setContentLimits')
        break
      case 'setSettings': {
        const days = Number(
          fields.trashRetentionDays ?? s.meta.value('trashRetentionDays', '30'),
        )
        if (!Number.isInteger(days) || days < 1 || days > 3650)
          throw new AppError(400, 'Retention must be 1 to 3650 days')
        if (
          fields.brand !== undefined &&
          (typeof fields.brand !== 'string' ||
            !fields.brand.trim() ||
            fields.brand.length > 60)
        )
          throw new AppError(400, 'Invalid display name')
        if (typeof fields.brand === 'string')
          s.meta.set('brand', fields.brand.trim())
        s.meta.set('trashRetentionDays', String(days))
        break
      }
      default:
        if (fields.action === 'setHome' && typeof fields.path === 'string') {
          const ref = resource({
            mountId: fields.mountId,
            segments: fields.path.split('/').filter(Boolean),
          })
          const entry = await s.fs.stat(ref, ownerGuard(s, user))
          if (entry.kind !== 'directory')
            throw new AppError(400, 'Select an existing home directory')
        }
        await s.identity.manage(user, fields)
    }
    return native ? go('/_/admin') : Response.json({ ok: true })
  }
  router.post(routes.admin, (ctx) => updateAdmin(ctx, true))
  router.post(routes.settings, (ctx) => updateAdmin(ctx, false))
  return router
}
