import { constants as C, type BigIntStats } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  type FileHandle,
} from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  AppError,
  type AppConfig,
  type Entry,
  type Mount,
  type ResourceRef,
} from '../contracts.ts'

export const marker = '.fileserver-root'
export const privateDir = '.fileserver-internal'
export const treeLimit = 20000
const directoryFlags = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW
const fileFlags = C.O_RDONLY | C.O_NONBLOCK | C.O_NOFOLLOW
const maxDepth = 96

export function fault(status: number, message: string): never {
  throw new AppError(status, message)
}
export function code(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined
}
export function storageError(error: unknown): AppError {
  if (error instanceof AppError) return error
  switch (code(error)) {
    case 'ENOENT':
    case 'ENOTDIR':
    case 'ELOOP':
      return new AppError(404, 'Entry unavailable')
    case 'EEXIST':
    case 'ENOTEMPTY':
      return new AppError(409, 'A destination entry already exists')
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return new AppError(403, 'Operation denied by storage')
    case 'ENOSPC':
    case 'EDQUOT':
      return new AppError(507, 'Storage is full')
    case 'EXDEV':
    case 'ENOTSUP':
    case 'EOPNOTSUPP':
      return new AppError(409, 'Operation unsupported on this storage')
    default:
      return new AppError(503, 'Storage operation unavailable')
  }
}
export function validateName(name: string): void {
  if (
    typeof name !== 'string' ||
    !name ||
    name === '.' ||
    name === '..' ||
    /[\\/\u0000]/u.test(name) ||
    name === marker ||
    name === privateDir ||
    Buffer.byteLength(name) > 255 ||
    Buffer.from(name).toString() !== name
  ) {
    fault(400, 'Invalid or reserved filename')
  }
}
export function checkRef(ref: ResourceRef): void {
  if (
    !ref ||
    typeof ref.mountId !== 'string' ||
    !Array.isArray(ref.segments) ||
    ref.segments.length > maxDepth
  )
    fault(400, 'Invalid logical path')
  for (const s of ref.segments) validateName(s)
}
export function child(ref: ResourceRef, name: string): ResourceRef {
  const result = { mountId: ref.mountId, segments: [...ref.segments, name] }
  checkRef(result)
  return result
}
export function leaf(ref: ResourceRef): string {
  return ref.segments.at(-1) ?? fault(403, 'Storage roots cannot be changed')
}
export function parent(ref: ResourceRef): ResourceRef {
  if (!ref.segments.length) fault(403, 'Storage roots cannot be changed')
  return { mountId: ref.mountId, segments: ref.segments.slice(0, -1) }
}
export function fdPath(h: FileHandle): string {
  return '/proc/self/fd/' + h.fd
}
export function identity(s: BigIntStats): string {
  return s.dev + ':' + s.ino
}
export function safeStat(s: BigIntStats, allowLinked = false): void {
  if (!s.isDirectory() && !(s.isFile() && (allowLinked || s.nlink === 1n)))
    fault(404, 'Entry unavailable')
  if (s.size > BigInt(Number.MAX_SAFE_INTEGER))
    fault(409, 'Size exceeds supported offset range')
}
export function version(s: BigIntStats): string {
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.birthtimeNs].join(':')
}
export function pinMatches(stored: string, meta: BigIntStats): boolean {
  const actual = version(meta)
  const fields = stored.split(':')
  if (fields.length === 5)
    return actual.split(':').slice(0, 5).join(':') === stored
  if (!meta.isDirectory() || meta.birthtimeNs <= 0n) return actual === stored
  return (
    fields.length === 6 &&
    identity(meta) === fields.slice(0, 2).join(':') &&
    fields[5] === String(meta.birthtimeNs)
  )
}
export function asEntry(
  ref: ResourceRef,
  s: BigIntStats,
  rootName: string,
): Entry {
  safeStat(s)
  return {
    ref,
    name: ref.segments.at(-1) ?? rootName,
    kind: s.isDirectory() ? 'directory' : 'file',
    size: s.isFile() ? Number(s.size) : 0,
    modifiedAt: s.mtime.toISOString(),
    version: version(s),
  }
}
async function mountId(h: FileHandle): Promise<string> {
  const info = await readFile('/proc/self/fdinfo/' + h.fd, 'utf8')
  const value = /^mnt_id:\s*(\d+)$/m.exec(info)?.[1]
  return value ?? fault(503, 'Storage mount identity unavailable')
}
// For bind mounts, mountinfo reports both the mountpoint visible to the
// application and its root within the underlying filesystem. Comparing
// configured pathname strings alone would miss two aliases of the same tree.
export function physicalLocation(mount: string, path: string, text: string) {
  const fields = text
    .split('\n')
    .find((line) => line.startsWith(mount + ' '))
    ?.split(' ')
  const device = fields?.[2],
    root = fields?.[3],
    point = fields?.[4]
  if (!device || !root || !point) fault(503, 'Storage topology unavailable')
  const unescape = (value: string) =>
    value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
      String.fromCharCode(parseInt(octal, 8)),
    )
  const rel = relative(unescape(point), path)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
    fault(503, 'Storage topology changed')
  return { device, path: resolve(unescape(root), rel) }
}
function containsPath(base: string, candidate: string) {
  const part = relative(base, candidate)
  return part !== '..' && !part.startsWith('../') && !isAbsolute(part)
}
export interface Root {
  h: FileHandle
  mount: Mount
  device: bigint
  id: string
}

export class Resolver {
  private roots = new Map<string, Mount>()
  private known = new Map<string, string>()
  private physical = new Map<string, { device: string; path: string }>()
  private overlaps = new Set<string>()
  constructor(
    mounts: Mount[],
    private readonly privateLocations: NonNullable<
      AppConfig['privateLocations']
    > = [],
  ) {
    const paths: string[] = []
    for (const mount of mounts) {
      if (
        !mount.id ||
        this.roots.has(mount.id) ||
        !isAbsolute(mount.path) ||
        !mount.sentinel?.trim() ||
        Buffer.byteLength(mount.sentinel) > 900 ||
        /[\r\n]/.test(mount.sentinel)
      )
        throw new Error('Invalid storage mount configuration')
      const path = resolve(mount.path)
      if (
        path === sep ||
        paths.some(
          (p) =>
            p === path || p.startsWith(path + sep) || path.startsWith(p + sep),
        )
      )
        throw new Error('Storage roots must be distinct and non-overlapping')
      paths.push(path)
      this.roots.set(mount.id, mount)
    }
  }
  async openRoot(id: string, write = false): Promise<Root> {
    const mount = this.roots.get(id)
    if (!mount) fault(404, 'Storage not available')
    if (this.overlaps.has(mount.id)) fault(503, 'Storage roots overlap')
    if (write && mount.readOnly) fault(403, 'Storage is read only')
    let h: FileHandle | undefined
    try {
      if ((await realpath(mount.path)) !== resolve(mount.path))
        fault(503, 'Storage mount unavailable')
      h = await open(mount.path, directoryFlags)
      const s = await h.stat({ bigint: true })
      const id = await mountId(h)
      const key = id + ':' + identity(s)
      if (this.known.has(mount.id) && this.known.get(mount.id) !== key)
        fault(503, 'Storage mount changed')
      const m = await open(fdPath(h) + '/' + marker, fileFlags)
      try {
        const meta = await m.stat({ bigint: true })
        if (
          !meta.isFile() ||
          meta.nlink !== 1n ||
          meta.size > 1024n ||
          meta.dev !== s.dev ||
          (await mountId(m)) !== id
        )
          fault(503, 'Storage marker unavailable')
        const buffer = Buffer.alloc(1025)
        const { bytesRead } = await m.read(buffer, 0, buffer.length, 0)
        if (
          buffer
            .subarray(0, bytesRead)
            .toString('utf8')
            .replace(/\r?\n$/, '') !== mount.sentinel
        )
          fault(503, 'Storage marker mismatch')
      } finally {
        await m.close()
      }
      if (!this.known.has(mount.id)) {
        const here = physicalLocation(
          id,
          mount.path,
          await readFile('/proc/self/mountinfo', 'utf8'),
        )
        if (
          this.privateLocations.some(
            (privatePath) =>
              privatePath.device === here.device &&
              (containsPath(here.path, privatePath.path) ||
                (privatePath.directory &&
                  containsPath(privatePath.path, here.path))),
          )
        )
          fault(503, 'Storage overlaps private state')
        for (const [otherId, other] of this.physical) {
          if (
            otherId !== mount.id &&
            other.device === here.device &&
            (containsPath(here.path, other.path) ||
              containsPath(other.path, here.path))
          ) {
            this.overlaps.add(otherId)
            this.overlaps.add(mount.id)
            fault(503, 'Storage roots overlap')
          }
        }
        this.physical.set(mount.id, here)
      }
      this.known.set(mount.id, key)
      return { h, mount, device: s.dev, id }
    } catch {
      await h?.close()
      return fault(503, 'Storage mount unavailable')
    }
  }
  async checked(
    root: Root,
    path: string,
    directory = false,
    allowLinked = false,
  ): Promise<FileHandle> {
    const before = await lstat(path, { bigint: true })
    safeStat(before, allowLinked)
    if (directory && !before.isDirectory()) fault(404, 'Directory unavailable')
    const h = await open(
      path,
      directory || before.isDirectory() ? directoryFlags : fileFlags,
    )
    try {
      const after = await h.stat({ bigint: true })
      safeStat(after, allowLinked)
      if (
        identity(before) !== identity(after) ||
        after.dev !== root.device ||
        (await mountId(h)) !== root.id
      )
        fault(404, 'Entry unavailable')
      return h
    } catch (e) {
      await h.close()
      throw e
    }
  }
  async directory(
    root: Root,
    segments: readonly string[],
    check?: (depth: number, h: FileHandle) => Promise<void>,
  ): Promise<FileHandle> {
    let h = await open(fdPath(root.h), C.O_RDONLY | C.O_DIRECTORY)
    try {
      let depth = 0
      await check?.(depth, h)
      for (const name of segments) {
        validateName(name)
        const next = await this.checked(root, fdPath(h) + '/' + name, true)
        await h.close()
        h = next
        await check?.(++depth, h)
      }
      return h
    } catch (e) {
      await h.close()
      throw e
    }
  }
  async private(root: Root, area: 'stage' | 'trash'): Promise<FileHandle> {
    let h = await open(fdPath(root.h), C.O_RDONLY | C.O_DIRECTORY)
    try {
      for (const name of [privateDir, area]) {
        const path = fdPath(h) + '/' + name
        await mkdir(path, { mode: 0o700 }).catch((e) => {
          if (code(e) !== 'EEXIST') throw e
        })
        const next = await this.checked(root, path, true)
        await h.close()
        h = next
        const meta = await h.stat()
        if (meta.uid !== process.getuid?.() || (meta.mode & 0o077) !== 0)
          fault(503, 'Storage internal directory permissions are unsafe')
      }
      return h
    } catch (e) {
      await h.close()
      throw e
    }
  }
}

// Linux entries with invalid UTF-8 cannot be addressed through the JSON API.
export async function* names(
  handle: FileHandle,
  skipInvalid: boolean,
): AsyncGenerator<string> {
  const directory = await opendir(fdPath(handle), { encoding: 'latin1' })
  let count = 0
  for await (const item of directory) {
    if (++count > treeLimit) fault(413, 'Directory entry limit exceeded')
    const bytes = Buffer.from(item.name, 'latin1')
    const name = bytes.toString('utf8')
    if (!Buffer.from(name).equals(bytes)) {
      if (skipInvalid) continue
      fault(409, 'Directory contains an unsupported filename')
    }
    if (name === marker || name === privateDir) {
      if (skipInvalid) continue
      fault(409, 'Directory contains reserved entries')
    }
    try {
      validateName(name)
    } catch (e) {
      if (skipInvalid) continue
      throw e
    }
    yield name
  }
}
