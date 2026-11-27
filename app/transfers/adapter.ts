import type {
  FileInfo,
  Part,
  TransferAdapter,
  UploadInput,
  UploadSession,
} from '../../shared/transfers.ts'
import { AppError, type ResourceRef, type User } from '../contracts.ts'
import { mustUser, ownerGuard } from '../http.ts'
import type { Access } from '../identity/index.ts'
import { requestRef, resource } from '../metadata.ts'
import type { Services } from '../runtime.ts'
import type { UploadAccess } from './uploads.ts'

import { encode, decode, fileId, fileRef } from './file-id.ts'

function info(ref: ResourceRef, size: number, id = fileId(ref)): FileInfo {
  const name = ref.segments.at(-1)
  if (!name) throw new AppError(404, 'Unknown file.')
  return { id, name, size, expiresAt: null }
}

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
function uploadRef(id: string) {
  if (uuid.test(id)) return { id }
  if (!id.startsWith('u_')) throw new AppError(404, 'Unknown upload.')
  const decoded = decode(id.slice(2))
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== 'string' ||
    !uuid.test(decoded[0]) ||
    typeof decoded[1] !== 'string' ||
    !decoded[1] ||
    decoded[1].length > 256
  )
    throw new AppError(404, 'Unknown upload.')
  return { id: decoded[0], alias: decoded[1] }
}

export async function bunUploadAccess(
  s: Services,
  access: Access,
  alias?: string | null,
): Promise<UploadAccess> {
  if (alias) return s.shares.uploadAccess(alias, access)
  const user = mustUser(access)
  return {
    actor: user.id,
    guard: ownerGuard(s, user),
    bandwidthBudgets: [s.identity.bandwidthBudget(user.id)],
    getQuota: () => s.identity.quota(user.id),
  }
}

export class BunTransferAdapter implements TransferAdapter {
  constructor(
    private readonly s: Services,
    private readonly request: Request,
    private readonly access: Access,
  ) {}

  private defaultFolder(user: User) {
    const ref =
      this.s.identity.home(user) ?? this.s.identity.entryPoints(user)[0]
    if (!ref) throw new AppError(403, 'Choose an accessible storage folder.')
    return ref
  }

  private async tus(
    method: string,
    id: string | undefined,
    access: UploadAccess,
    headers?: Record<string, string>,
  ) {
    const req = new Request(this.request.url, {
      method,
      signal: this.request.signal,
      headers: { 'Tus-Resumable': '1.0.0', ...headers },
    })
    const response = await this.s.transfers.upload(req, access, id)
    if (!response.ok)
      throw new AppError(
        response.status,
        (await response.text()) || 'The upload is unavailable.',
      )
    return response
  }

  async create(input: UploadInput): Promise<UploadSession> {
    const actor = await bunUploadAccess(this.s, this.access, input.requestAlias)
    if (input.idempotencyKey) actor.idempotencyKey = input.idempotencyKey
    const metadata: Record<string, string> = { filename: input.name }
    if (!input.requestAlias) {
      const parent = input.target
        ? resource(input.target)
        : this.defaultFolder(mustUser(this.access))
      metadata.mount = parent.mountId
      metadata.path = parent.segments.join('/')
    }
    const encoded = Object.entries(metadata)
      .filter(([, value]) => value !== '')
      .map(([key, value]) => key + ' ' + Buffer.from(value).toString('base64'))
      .join(',')
    const result = await this.tus('POST', undefined, actor, {
      'Upload-Length': String(input.size),
      'Upload-Metadata': encoded,
    })
    const location = result.headers.get('Location')
    if (!location) throw new AppError(500, 'Upload location unavailable.')
    const id = new URL(location, this.request.url).pathname.split('/').at(-1)
    if (!id || !uuid.test(id))
      throw new AppError(500, 'Invalid upload location.')
    return {
      transport: 'tus',
      id: input.requestAlias ? 'u_' + encode([id, input.requestAlias]) : id,
      url: location,
      chunkSize: this.s.transfers.limits.maxChunkBytes,
    }
  }

  async part(id: string, _number: number): Promise<string> {
    const ref = uploadRef(id)
    await this.tus(
      'HEAD',
      ref.id,
      await bunUploadAccess(this.s, this.access, ref.alias),
    )
    throw new AppError(409, 'Send file chunks to the TUS upload URL.')
  }

  async complete(id: string, parts: Part[]): Promise<FileInfo> {
    const ref = uploadRef(id)
    const access = await bunUploadAccess(this.s, this.access, ref.alias)
    if (parts.length)
      throw new AppError(400, 'A TUS upload does not use multipart ETags.')
    // HEAD reconciles durable publish intents using the native TUS recovery path.
    await this.tus('HEAD', ref.id, access)
    const file = this.s.transfers.published(ref.id, access)
    return info(file.ref, file.size, ref.alias ? id : undefined)
  }

  async cancel(id: string) {
    const ref = uploadRef(id)
    await this.tus(
      'DELETE',
      ref.id,
      await bunUploadAccess(this.s, this.access, ref.alias),
    )
  }

  async list(url: URL) {
    const user = mustUser(this.access)
    const ref =
      url.searchParams.has('mount') || url.searchParams.has('path')
        ? requestRef(url)
        : this.defaultFolder(user)
    const entries = await this.s.fs.list(ref, ownerGuard(this.s, user))
    return entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => info(entry.ref, entry.size))
  }

  async download(id: string) {
    const guard = ownerGuard(this.s, mustUser(this.access))
    const ref = fileRef(id)
    const entry = await this.s.fs.stat(ref, guard, 'read')
    if (entry.kind !== 'file') throw new AppError(404, 'Unknown file.')
    return (
      '/_/download?' +
      new URLSearchParams({ mount: ref.mountId, path: ref.segments.join('/') })
    )
  }

  async remove(id: string) {
    const guard = ownerGuard(this.s, mustUser(this.access))
    const ref = fileRef(id)
    const entry = await this.s.fs.stat(ref, guard, 'delete')
    if (entry.kind !== 'file') throw new AppError(404, 'Unknown file.')
    const pinned = Object.assign(guard, {
      targetPins: [{ ref, version: entry.version }],
    })
    await this.s.fs.operate(
      'trash',
      ref,
      null,
      pinned,
      'reject',
      this.request.signal,
    )
  }
}
