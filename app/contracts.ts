export type User = { id: string; username: string; admin: boolean }
export const defaultBrand = 'lshare'

export type ResourceRef = { mountId: string; segments: string[] }
export type Action =
  | 'list'
  | 'read'
  | 'create'
  | 'upload'
  | 'modify'
  | 'rename'
  | 'copy'
  | 'move'
  | 'delete'
  | 'share'
  | 'manage'
export const actions: readonly Action[] = [
  'list',
  'read',
  'create',
  'upload',
  'modify',
  'rename',
  'copy',
  'move',
  'delete',
  'share',
  'manage',
]
export type Guard = ((action: Action, ref: ResourceRef) => void) & {
  readonly targetPins?: readonly { ref: ResourceRef; version: string }[]
}
export type Mount = {
  id: string
  label: string
  path: string
  readOnly: boolean
  sentinel: string
}
export type Entry = {
  ref: ResourceRef
  name: string
  kind: 'file' | 'directory'
  size: number
  modifiedAt: string
  version: string
  permissions?: Action[]
}
export type AppConfig = {
  dataDir: string
  publicOrigin: string
  sessionSecret: string
  bootstrapFile?: string
  brandIcon?: Uint8Array
  mounts: Mount[]
  privateLocations?: readonly {
    device: string
    path: string
    directory: boolean
  }[]
  transferLimits?: {
    maxChunkBytes: number
    maxConcurrent: number
    perActorConcurrent: number
    bytesPerSecond: number
    uploadTtlMs: number
  }
  trustedProxies?: string[]
  port: number
}
export class AppError extends Error {
  readonly _tag = 'AppError' as const
  constructor(
    public readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AppError'
  }
}
