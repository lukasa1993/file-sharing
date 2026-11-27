import { AppError, type Guard, type User } from './contracts.ts'
import type { Access } from './identity/index.ts'
import type { Services } from './runtime.ts'
export function mustUser(access: Access): User {
  if (!access.user) throw new AppError(401, 'Sign in to continue')
  return access.user
}
export function ownerGuard(s: Services, user: User): Guard {
  return (action, ref) => {
    if (!s.identity.allowed(user, action, ref))
      throw new AppError(403, 'You do not have access to this item')
  }
}
export function adminUser(s: Services, access: Access) {
  const user = mustUser(access)
  if (access.bearer || !user.admin || !s.identity.getUser(user.id)?.admin)
    throw new AppError(403, 'Administrator access required')
  return user
}
export function go(location: string) {
  return new Response(null, { status: 303, headers: { Location: location } })
}
export function localNext(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\x00-\x1f]/.test(value)
  )
    return '/'
  return value
}
export async function data(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type')?.split(';', 1)[0]?.trim()
  if (type === 'application/json') {
    let value: unknown
    try {
      value = await request.json()
    } catch {
      throw new AppError(400, 'Invalid JSON')
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new AppError(400, 'Expected a JSON object')
    return Object.fromEntries(Object.entries(value))
  }
  if (
    type === 'application/x-www-form-urlencoded' ||
    type === 'multipart/form-data'
  ) {
    try {
      return Object.fromEntries(await request.formData())
    } catch {
      throw new AppError(400, 'Invalid form submission')
    }
  }
  throw new AppError(415, 'Expected JSON or a form submission')
}
// Parse small control bodies once before any middleware clones the request.
// Raw transfer chunks have independent streaming and byte limits.
export async function boundedRequest(request: Request): Promise<Request> {
  if (!request.body) return request
  const path = new URL(request.url).pathname
  if (request.method === 'PATCH' && /^\/_\/uploads\/[a-zA-Z0-9-]+$/.test(path))
    return request
  const max = request.method === 'PUT' && path === '/_/preview' ? 262144 : 65536
  if (Number(request.headers.get('content-length') || 0) > max)
    throw new AppError(413, 'Request too large')
  const chunks: Uint8Array[] = []
  const reader = request.body.getReader()
  let bytes = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > max) {
        await reader.cancel()
        throw new AppError(413, 'Request too large')
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    body: Buffer.concat(chunks, bytes),
  })
}
export function isPage(url: URL, request: Request) {
  return (
    !url.pathname.startsWith('/_/api/') &&
    !url.pathname.startsWith('/_/uploads') &&
    (request.method === 'GET' || request.method === 'POST') &&
    (request.headers.get('accept') ?? '').includes('text/html')
  )
}
export function errorBody(error: unknown, requestId: string) {
  const status = error instanceof AppError ? error.status : 500
  return {
    status,
    message:
      error instanceof AppError && status < 500
        ? error.message
        : status === 503
          ? 'Storage is unavailable'
          : 'The request could not be completed',
    requestId,
  }
}
