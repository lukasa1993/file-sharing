import { controlJson, TransferError, type TransferTarget } from './transfers.ts'

type LinkAccess = 'public' | 'verified' | 'password'
export type OwnerShare = {
  id: string
  alias: string
  href: string
  kind: 'file' | 'request' | 'folder' | 'selection'
  access: LinkAccess
  fileId: string | null
  createdAt: number | null
  expiresAt: number | null
  revoked: boolean
  enabled?: boolean
  unavailable?: boolean
}
export type OwnerShareInput = {
  kind: 'file' | 'request'
  fileId?: string
  access?: LinkAccess
  alias?: string
  password?: string
  expiresAt?: number | null
  target?: TransferTarget
  confirmPublic?: boolean
}
export interface OwnerShareAdapter {
  list(): OwnerShare[] | Promise<OwnerShare[]>
  create(input: OwnerShareInput): Promise<OwnerShare>
  revoke(id: string): void | Promise<void>
}

const bad = (message: string) => new TransferError(400, message)
const privateHeaders = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
}
function shareInput(fields: Record<string, unknown>): OwnerShareInput {
  const keys = [
    'kind',
    'fileId',
    'access',
    'alias',
    'password',
    'expiresAt',
    'target',
    'confirmPublic',
  ]
  if (Object.keys(fields).some((key) => !keys.includes(key)))
    throw bad('Unexpected link metadata.')
  const {
    kind,
    fileId,
    access,
    alias,
    password,
    expiresAt,
    target,
    confirmPublic,
  } = fields
  if (kind !== 'file' && kind !== 'request') throw bad('Choose the link type.')
  if (
    kind === 'file' &&
    (typeof fileId !== 'string' ||
      !fileId ||
      fileId.length > 8192 ||
      target !== undefined)
  )
    throw bad('Choose a file to share.')
  if (kind === 'request' && fileId !== undefined)
    throw bad('Upload requests accept new files only.')
  if (
    access !== undefined &&
    access !== 'public' &&
    access !== 'password' &&
    access !== 'verified'
  )
    throw bad('Choose the link access.')
  if (
    (alias !== undefined && typeof alias !== 'string') ||
    (password !== undefined &&
      (typeof password !== 'string' || (password && access !== 'password'))) ||
    (confirmPublic !== undefined && typeof confirmPublic !== 'boolean')
  )
    throw bad('Invalid link metadata.')
  if (
    expiresAt != null &&
    (typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > 8.64e15)
  )
    throw bad('Choose a future link expiry.')
  const input: OwnerShareInput = { kind }
  if (typeof fileId === 'string') input.fileId = fileId
  if (access !== undefined) input.access = access
  if (alias !== undefined) input.alias = alias
  if (password !== undefined) input.password = password
  if (expiresAt !== undefined) input.expiresAt = expiresAt
  if (confirmPublic !== undefined) input.confirmPublic = confirmPublic
  if (target !== undefined) {
    if (
      !target ||
      typeof target !== 'object' ||
      Array.isArray(target) ||
      Object.keys(target).some((k) => k !== 'mountId' && k !== 'segments') ||
      !('mountId' in target) ||
      typeof target.mountId !== 'string' ||
      !target.mountId ||
      !('segments' in target) ||
      !Array.isArray(target.segments) ||
      !target.segments.every((s) => typeof s === 'string')
    )
      throw bad('Choose a storage folder for the upload request.')
    input.target = { mountId: target.mountId, segments: target.segments }
  }
  return input
}

export async function ownerShareApi(
  request: Request,
  adapter: OwnerShareAdapter,
): Promise<Response> {
  const path = new URL(request.url).pathname
  const collection = path === '/api/shares'
  const id = /^\/api\/shares\/([0-9a-f-]{36})$/.exec(path)?.[1]
  if (!collection && !id) throw new TransferError(404, 'Link unavailable.')
  if (collection && request.method === 'GET')
    return Response.json(
      { shares: await adapter.list() },
      { headers: privateHeaders },
    )
  if (collection && request.method === 'POST') {
    const link = await adapter.create(shareInput(await controlJson(request)))
    return Response.json(link, { status: 201, headers: privateHeaders })
  }
  if (id && request.method === 'DELETE') {
    await adapter.revoke(id)
    return new Response(null, { status: 204, headers: privateHeaders })
  }
  return Response.json(
    { error: 'Method unavailable.' },
    {
      status: 405,
      headers: {
        ...privateHeaders,
        Allow: collection ? 'GET, POST' : 'DELETE',
      },
    },
  )
}
