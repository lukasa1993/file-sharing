import type {
  OwnerShare,
  OwnerShareAdapter,
  OwnerShareInput,
} from '../../shared/shares.ts'
import { AppError, type ResourceRef, type User } from '../contracts.ts'
import { runTask } from '../effects.ts'
import { ownerGuard } from '../http.ts'
import { resource } from '../metadata.ts'
import type { Services } from '../runtime.ts'
import { fileId, fileRef } from '../transfers/file-id.ts'

type OwnedRecord = ReturnType<Services['shares']['ownedLinks']>[number]
function portableShare({ share, kind, createdAt }: OwnedRecord): OwnerShare {
  const [ref] = share.targets
  return {
    id: share.id,
    alias: share.alias,
    href: '/' + encodeURIComponent(share.alias),
    kind,
    access: share.access === 'authenticated' ? 'verified' : share.access,
    fileId: kind === 'file' && ref ? fileId(ref) : null,
    createdAt,
    expiresAt: share.expiresAt ? Date.parse(share.expiresAt) : null,
    revoked: false,
    enabled: share.enabled,
    unavailable: share.status === 'Unavailable',
  }
}
export class BunShareAdapter implements OwnerShareAdapter {
  constructor(
    private readonly s: Services,
    private readonly actor: User,
  ) {}
  list() {
    return this.s.shares.ownedLinks(this.actor).map(portableShare)
  }
  private writable(ref: ResourceRef) {
    return (
      this.s.config.mounts.some((m) => m.id === ref.mountId && !m.readOnly) &&
      this.s.fs.isEnabled(ref.mountId) &&
      this.s.identity.allowed(this.actor, 'share', ref) &&
      this.s.identity.allowed(this.actor, 'upload', ref)
    )
  }
  private async defaultFolder() {
    const home = this.s.identity.home(this.actor)
    const candidates = [
      ...(home ? [home] : []),
      ...this.s.identity.entryPoints(this.actor),
      ...this.s.config.mounts.map((m) => ({ mountId: m.id, segments: [] })),
    ]
    for (const ref of candidates) {
      if (!this.writable(ref)) continue
      try {
        const entry = await this.s.fs.stat(
          ref,
          ownerGuard(this.s, this.actor),
          'upload',
        )
        if (entry.kind === 'directory') return ref
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          ![403, 404, 503].includes(error.status)
        )
          throw error
      }
    }
    throw new AppError(403, 'Choose a writable folder you can share.')
  }
  async create(input: OwnerShareInput) {
    let ref: ResourceRef
    if (input.kind === 'file') {
      if (!input.fileId) throw new AppError(400, 'Choose a file to share.')
      ref = fileRef(input.fileId)
    } else {
      ref = input.target ? resource(input.target) : await this.defaultFolder()
      if (!this.writable(ref))
        throw new AppError(403, 'Choose a writable folder you can share.')
    }
    const link = await runTask(
      this.s.shares.saveEffect(
        this.actor,
        {
          kind: input.kind === 'file' ? 'download' : 'upload',
          mode: 'landing',
          targets: [ref],
          access:
            input.access === 'verified' || input.access === undefined
              ? 'authenticated'
              : input.access,
          ...(input.expiresAt == null
            ? {}
            : { expiresAt: new Date(input.expiresAt).toISOString() }),
          ...(input.alias === undefined ? {} : { alias: input.alias }),
          ...(input.password === undefined ? {} : { password: input.password }),
          ...(input.confirmPublic === undefined
            ? {}
            : { confirmPublic: input.confirmPublic }),
        },
        undefined,
        input.kind === 'file' ? 'file' : 'directory',
      ),
    )
    const [created] = this.s.shares.ownedLinks(this.actor, link.id)
    if (!created) throw new AppError(404, 'Share unavailable.')
    return portableShare(created)
  }
  revoke(id: string) {
    this.s.shares.revokeOwned(this.actor, id)
  }
}
