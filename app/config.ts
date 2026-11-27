import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { physicalLocation } from './filesystem/resolver.ts'
import {
  array,
  boolean,
  defaulted,
  object,
  parseSafe,
  string,
} from 'remix/data-schema'
import type { AppConfig } from './contracts.ts'

const mountConfig = object({
  id: string(),
  label: string(),
  path: string(),
  readOnly: defaulted(boolean(), false),
  sentinel: string(),
})
const settings = object({ mounts: array(mountConfig) })

export function overlaps(a: string, b: string) {
  const rel = relative(a, b)
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
  )
}

function required(env: Record<string, string | undefined>, name: string) {
  const value = env[name]
  if (!value) throw new Error('Missing configuration: ' + name)
  return value
}

function readSmallFile(path: string, max: number, secret = false) {
  const fd = openSync(
    path,
    constants.O_RDONLY |
      constants.O_NONBLOCK |
      (secret ? constants.O_NOFOLLOW : 0),
  )
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > max)
      throw new Error('Configuration must be a bounded regular file')
    if (
      secret &&
      ((st.mode & 0o077) !== 0 ||
        st.nlink !== 1 ||
        (st.uid !== 0 && st.uid !== process.getuid?.()))
    )
      throw new Error('Session secret file must be private')
    const bytes = Buffer.alloc(max + 1)
    let used = 0
    while (used < bytes.length) {
      const n = readSync(fd, bytes, used, bytes.length - used, null)
      if (!n) break
      used += n
    }
    if (used !== st.size || used > max)
      throw new Error('Configuration file changed while reading')
    return bytes.toString('utf8', 0, used)
  } finally {
    closeSync(fd)
  }
}

// Missing volumes and first-start data directories have no descriptor yet.
// Resolve their nearest existing ancestor without creating anything.
function locate(path: string, topology: string) {
  const requested = resolve(path)
  let ancestor = requested
  while (!lstatSync(ancestor, { throwIfNoEntry: false }))
    ancestor = dirname(ancestor)
  const actual = realpathSync(ancestor)
  const canonical = resolve(actual, relative(ancestor, requested))
  const fd = openSync(
    actual,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const id = /^mnt_id:\s*(\d+)$/m.exec(
      readFileSync('/proc/self/fdinfo/' + fd, 'utf8'),
    )?.[1]
    if (!id) throw new Error('Storage topology unavailable')
    return { canonical, ...physicalLocation(id, canonical, topology) }
  } finally {
    closeSync(fd)
  }
}
type Location = ReturnType<typeof locate>
function contains(a: Location, b: Location) {
  return (
    overlaps(a.canonical, b.canonical) ||
    (a.device === b.device && overlaps(a.path, b.path))
  )
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const origin = new URL(required(env, 'PUBLIC_ORIGIN'))
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:'))
  )
    throw new Error('Invalid public origin. Use HTTPS or loopback HTTP.')
  const port = Number(env.PORT || 8080)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid listening port')
  const settingsFile = resolve(required(env, 'CONFIG_FILE'))
  const parsed = parseSafe(
    settings,
    JSON.parse(readSmallFile(settingsFile, 65536)),
  )
  if (
    !parsed.success ||
    !parsed.value.mounts.length ||
    parsed.value.mounts.length > 64
  )
    throw new Error('Provide 1 to 64 configured mounts')
  const topology = readFileSync('/proc/self/mountinfo', 'utf8')
  const data = locate(required(env, 'DATA_DIR'), topology)
  const dataDir = data.canonical
  const dataStat = lstatSync(dataDir, { throwIfNoEntry: false })
  if (dataStat && (!dataStat.isDirectory() || (dataStat.mode & 0o022) !== 0))
    throw new Error('Application data requires a private writable directory')
  const secretPath = resolve(required(env, 'SESSION_SECRET_FILE'))
  const bootstrapFile = env.BOOTSTRAP_FILE
    ? resolve(env.BOOTSTRAP_FILE)
    : undefined
  const sessionSecret = readSmallFile(secretPath, 4096, true).trim()
  if (Buffer.byteLength(sessionSecret) < 32)
    throw new Error('Session signing secret must have at least 32 bytes')
  const reserved = [
    data,
    locate(secretPath, topology),
    locate(settingsFile, topology),
    ...(bootstrapFile ? [locate(bootstrapFile, topology)] : []),
  ]
  for (const name of [
    'fileserver.sqlite',
    'fileserver.sqlite-wal',
    'fileserver.sqlite-shm',
    'fileserver.sqlite-journal',
  ]) {
    const path = join(dataDir, name)
    const st = lstatSync(path, { throwIfNoEntry: false })
    if (!st) continue
    if (!st.isFile() || st.nlink !== 1)
      throw new Error('Database state requires regular private files')
    reserved.push(locate(path, topology))
  }
  const ids = new Set<string>()
  const seen: Location[] = []
  for (const mount of parsed.value.mounts) {
    if (
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(mount.id) ||
      ids.has(mount.id) ||
      !mount.label.trim() ||
      mount.label.length > 128 ||
      !mount.sentinel.trim() ||
      mount.sentinel.length > 256 ||
      /[\r\n]/.test(mount.sentinel) ||
      !isAbsolute(mount.path) ||
      resolve(mount.path) === '/'
    )
      throw new Error('Invalid or duplicate mount configuration')
    mount.path = resolve(mount.path)
    const root = locate(mount.path, topology)
    if (root.canonical !== mount.path)
      throw new Error('Mount path contains a symbolic link')
    if (
      reserved.some((path) => contains(root, path)) ||
      contains(data, root) ||
      seen.some((path) => contains(path, root) || contains(root, path))
    )
      throw new Error('Storage roots and private state must be separate')
    ids.add(mount.id)
    seen.push(root)
  }
  function limit(key: string, fallback: number, min: number, max: number) {
    const value = Number(env[key] ?? fallback)
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error('Invalid ' + key)
    return value
  }
  const transferLimits = {
    maxChunkBytes: limit(
      'MAX_CHUNK_BYTES',
      16 * 1024 * 1024,
      1024,
      32 * 1024 * 1024,
    ),
    maxConcurrent: limit('MAX_TRANSFERS', 32, 1, 512),
    perActorConcurrent: limit('MAX_TRANSFERS_PER_USER', 8, 1, 512),
    bytesPerSecond: limit(
      'TRANSFER_BYTES_PER_SECOND',
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    uploadTtlMs: limit('UPLOAD_TTL_SECONDS', 86400, 60, 2592000) * 1000,
  }
  return {
    port,
    transferLimits,
    trustedProxies: (env.TRUSTED_PROXY_CIDRS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    publicOrigin: origin.origin,
    dataDir,
    sessionSecret,
    mounts: parsed.value.mounts,
    privateLocations: reserved.map((location) => ({
      device: location.device,
      path: location.path,
      directory: location === data,
    })),
    ...(bootstrapFile ? { bootstrapFile } : {}),
  }
}
