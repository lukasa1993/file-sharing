import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'

function requireEnv(key: string) {
  let value = Bun.env[key]
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value.trim()
}

function optionalEnvInt(key: string) {
  let value = Bun.env[key]
  if (!value) return undefined
  let parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function resolvePath(value: string) {
  return isAbsolute(value) ? value : resolve(process.cwd(), value)
}

function ensureDirectory(pathname: string) {
  mkdirSync(pathname, { recursive: true })
}

const adminUser = requireEnv('FS_ADMIN_USER')
const adminPasswordHash = Buffer.from(requireEnv('FS_ADMIN_PASSWORD'), 'base64url').toString(
  'utf-8',
)

const storageRoot = resolvePath(requireEnv('FS_STORAGE_ROOT'))
ensureDirectory(storageRoot)

const dbDirectory = resolvePath(requireEnv('FS_DB_DIR'))
ensureDirectory(dbDirectory)

const resumableRoot = join(dbDirectory, '.resumable')
ensureDirectory(resumableRoot)

const shareStoreFile = join(dbDirectory, 'shares.json')
const sessionSecret = Bun.env.FS_SESSION_SECRET?.trim() || randomBytes(32).toString('hex')
const sessionMaxAgeSeconds = optionalEnvInt('FS_SESSION_MAX_AGE') ?? 60 * 60 * 8
const secureCookies = (Bun.env.NODE_ENV ?? '').toLowerCase() === 'production'

export const config = {
  adminUser,
  adminPasswordHash,
  storageRoot,
  dbDirectory,
  resumableRoot,
  shareStoreFile,
  sessionSecret,
  sessionMaxAgeSeconds,
  secureCookies,
}
