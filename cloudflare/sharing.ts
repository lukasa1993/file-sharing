import { TransferError } from '../shared/transfers.ts'

type SqlValue = string | number | null
export interface SharingSql {
  exec<T extends Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): Iterable<T>
}
// The caller supplies identities only after the authentication adapter has verified them.
export type ShareActor = { id: string }
export type ShareKind = 'file' | 'request'
export type ShareAccess = 'public' | 'verified' | 'password'
export type CloudShareFile = {
  id: string
  name: string
  size: number
  expiresAt: number
}
export type CloudShare = {
  id: string
  alias: string
  kind: ShareKind
  access: ShareAccess
  fileId: string | null
  createdAt: number
  expiresAt: number | null
  revoked: boolean
}
export type CreateShare = {
  kind: ShareKind
  fileId?: string
  access?: ShareAccess
  alias?: string
  password?: string
  expiresAt?: number | null
}
type OwnerRow = Omit<CloudShare, 'revoked'> & { revoked: number }
type Row = OwnerRow & {
  ownerId: string
  salt: string | null
  verifier: string | null
}

const missing = () => new TransferError(404, 'Link unavailable.')
const invalid = (message: string) => new TransferError(400, message)
const busy = () =>
  new TransferError(429, 'Too many password requests. Try again in a minute.')
const signIn = () => new TransferError(401, 'Sign in with a verified account.')
const encoder = new TextEncoder()
const verifierLabel = encoder.encode('Server Key')
const aliasPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const bytes = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
const token = () => hex(crypto.getRandomValues(new Uint8Array(16)))
function actorId(actor: ShareActor | null) {
  if (!actor || typeof actor.id !== 'string' || !actor.id) throw signIn()
  return actor.id
}
function shareView(row: OwnerRow): CloudShare {
  return {
    id: row.id,
    alias: row.alias,
    kind: row.kind,
    access: row.access,
    fileId: row.fileId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revoked: Boolean(row.revoked),
  }
}
// Web Crypto performs both derivation and verification. The single PBKDF2 call uses
// the Workers runtime's maximum iteration count; each verifier has its own random salt.
async function passwordKey(password: string, salt: string) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bytes(salt), iterations: 100_000 },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  )
}
const validPassword = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 &&
  encoder.encode(value).length <= 512

export class CloudSharing {
  private passwordJobs = 0
  constructor(
    private readonly sql: SharingSql,
    private readonly findFile: (
      ownerId: string,
      fileId: string,
      now: number,
    ) => CloudShareFile | null,
    private readonly clock = () => Date.now(),
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS cloud_shares (
      id TEXT PRIMARY KEY, alias TEXT NOT NULL UNIQUE, ownerId TEXT NOT NULL, kind TEXT NOT NULL,
      access TEXT NOT NULL, fileId TEXT, createdAt INTEGER NOT NULL, expiresAt INTEGER, revoked INTEGER NOT NULL DEFAULT 0,
      salt TEXT, verifier TEXT, CHECK(kind IN ('file','request')), CHECK(access IN ('public','verified','password')),
      CHECK((kind='request' AND fileId IS NULL AND access='verified') OR (kind='file' AND fileId IS NOT NULL))
    )`)
    sql.exec(
      'CREATE INDEX IF NOT EXISTS cloud_shares_owner ON cloud_shares(ownerId,createdAt DESC)',
    )
    sql.exec(
      'CREATE TABLE IF NOT EXISTS cloud_share_password_budget (key TEXT PRIMARY KEY, minute INTEGER NOT NULL, used INTEGER NOT NULL)',
    )
  }

  private checkFile(ownerId: string, fileId: string, now: number) {
    const file = this.findFile(ownerId, fileId, now)
    if (
      !file ||
      file.id !== fileId ||
      !Number.isSafeInteger(file.expiresAt) ||
      file.expiresAt <= now
    )
      throw missing()
    return file
  }
  private active(key: 'alias' | 'id', value: string, now: number) {
    const row = [
      ...this.sql.exec<Row>(
        `SELECT * FROM cloud_shares WHERE ${key}=? AND revoked=0
       AND (expiresAt IS NULL OR expiresAt>?)`,
        value,
        now,
      ),
    ][0]
    if (!row) throw missing()
    return row
  }
  private async passwordWork<T>(
    key: string,
    client: string,
    work: () => Promise<T>,
    now: number,
  ) {
    if (this.passwordJobs >= 2) throw busy()
    this.passwordJobs++
    try {
      const digest = hex(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', encoder.encode(client)),
        ),
      )
      const minute = Math.floor(now / 60_000)
      this.sql.exec(
        'DELETE FROM cloud_share_password_budget WHERE minute<>?',
        minute,
      )
      const limits: [string, number][] = [
        ['global', 64],
        [key, 16],
        ['client:' + digest, 8],
      ]
      // Synchronous SQL calls cannot interleave within this Durable Object turn.
      for (const [scope, limit] of limits) {
        const row = [
          ...this.sql.exec<{ used: number }>(
            'SELECT used FROM cloud_share_password_budget WHERE key=?',
            scope,
          ),
        ][0]
        if (row && row.used >= limit) throw busy()
      }
      for (const [scope] of limits)
        this.sql.exec(
          `INSERT INTO cloud_share_password_budget(key,minute,used) VALUES(?,?,1)
            ON CONFLICT(key) DO UPDATE SET used=used+1`,
          scope,
          minute,
        )
      return await work()
    } finally {
      this.passwordJobs--
    }
  }

  async create(
    actor: ShareActor | null,
    input: CreateShare,
    now?: number,
  ): Promise<CloudShare> {
    const ownerId = actorId(actor)
    if (
      !input ||
      typeof input !== 'object' ||
      !['file', 'request'].includes(input.kind)
    )
      throw invalid('Choose a file link or an upload request.')
    const at = now ?? this.clock()
    const access =
      input.access ?? (input.kind === 'request' ? 'verified' : 'public')
    if (!['public', 'verified', 'password'].includes(access))
      throw invalid('Choose public, verified-account or password access.')
    if (
      input.kind === 'request' &&
      (access !== 'verified' || input.fileId !== undefined)
    )
      throw invalid(
        'Upload requests require verified accounts and accept new files only.',
      )
    if (
      input.alias !== undefined &&
      (typeof input.alias !== 'string' ||
        (input.alias !== '' && !aliasPattern.test(input.alias)))
    )
      throw invalid(
        'Choose a lowercase alias of up to 64 letters, digits, underscores or hyphens.',
      )
    if (
      input.expiresAt != null &&
      (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= at)
    )
      throw invalid('Choose a future link expiry.')
    const fileId = input.kind === 'file' ? input.fileId : null
    if (
      fileId === undefined ||
      (fileId !== null &&
        (typeof fileId !== 'string' || !fileId || fileId.length > 256)) ||
      (input.kind === 'file' && fileId === null)
    )
      throw invalid('Choose a file to share.')
    let salt: string | null = null,
      verifier: string | null = null
    if (access === 'password') {
      if (fileId !== null) this.checkFile(ownerId, fileId, at)
      const password = input.password
      if (!validPassword(password))
        throw invalid('Enter a share password of up to 512 bytes.')
      const generated = token()
      salt = generated
      verifier = await this.passwordWork(
        'owner:' + ownerId,
        'owner:' + ownerId,
        async () =>
          hex(
            new Uint8Array(
              await crypto.subtle.sign(
                'HMAC',
                await passwordKey(password, generated),
                verifierLabel,
              ),
            ),
          ),
        at,
      )
    } else if (input.password !== undefined && input.password !== '') {
      throw invalid('Choose password access to set a password.')
    }
    const committed = now ?? this.clock()
    let expiry = input.expiresAt ?? null
    if (fileId !== null) {
      const file = this.checkFile(ownerId, fileId, committed)
      expiry = Math.min(expiry ?? file.expiresAt, file.expiresAt)
    }
    if (expiry !== null && expiry <= committed)
      throw invalid('Choose a future link expiry.')
    const row = [
      ...this.sql.exec<Row>(
        `INSERT INTO cloud_shares
      (id,alias,ownerId,kind,access,fileId,createdAt,expiresAt,salt,verifier) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(alias) DO NOTHING RETURNING *`,
        crypto.randomUUID(),
        input.alias || token(),
        ownerId,
        input.kind,
        access,
        fileId,
        committed,
        expiry,
        salt,
        verifier,
      ),
    ][0]
    if (!row)
      throw new TransferError(409, 'This alias is unavailable. Choose another.')
    return shareView(row)
  }

  list(actor: ShareActor | null, _now?: number): CloudShare[] {
    return Array.from(
      this.sql.exec<OwnerRow>(
        `SELECT id,alias,kind,access,fileId,createdAt,expiresAt,revoked
         FROM cloud_shares WHERE ownerId=? ORDER BY createdAt DESC,id`,
        actorId(actor),
      ),
      shareView,
    )
  }
  revoke(actor: ShareActor | null, id: string) {
    const row = [
      ...this.sql.exec<{ id: string }>(
        `UPDATE cloud_shares SET revoked=1,salt=NULL,verifier=NULL
      WHERE id=? AND ownerId=? RETURNING id`,
        id,
        actorId(actor),
      ),
    ][0]
    if (!row) throw missing()
  }
  recipient(alias: string, now = this.clock()) {
    const row = this.active('alias', alias, now)
    if (row.fileId !== null) this.checkFile(row.ownerId, row.fileId, now)
    return { alias: row.alias, kind: row.kind, access: row.access }
  }
  async authorizeDownload(
    alias: string,
    actor: ShareActor | null,
    password: string | null = null,
    now?: number,
    clientKey?: string,
  ) {
    const at = now ?? this.clock()
    const row = this.active('alias', alias, at)
    if (row.kind !== 'file' || row.fileId === null) throw missing()
    if (row.access === 'verified') actorId(actor)
    if (row.access === 'password') {
      if (!validPassword(password))
        throw new TransferError(401, 'Enter the share password.')
      const { salt, verifier } = row
      if (!salt || !verifier) throw missing()
      const verified = await this.passwordWork(
        'share:' + row.id,
        clientKey ?? actor?.id ?? 'anonymous',
        async () =>
          crypto.subtle.verify(
            'HMAC',
            await passwordKey(password, salt),
            bytes(verifier),
            verifierLabel,
          ),
        at,
      )
      if (!verified) throw new TransferError(403, 'Incorrect share password.')
    }
    const checked = now ?? this.clock()
    this.active('id', row.id, checked)
    const file = this.checkFile(row.ownerId, row.fileId, checked)
    return {
      fileId: row.fileId,
      ownerId: row.ownerId,
      name: file.name,
      size: file.size,
      expiresAt: Math.min(row.expiresAt ?? file.expiresAt, file.expiresAt),
    }
  }
  private upload(
    key: 'id' | 'alias',
    value: string,
    actor: ShareActor | null,
    now: number,
  ) {
    actorId(actor)
    const row = this.active(key, value, now)
    if (row.kind !== 'request' || row.access !== 'verified') throw missing()
    return { requestId: row.id, ownerId: row.ownerId, expiresAt: row.expiresAt }
  }
  authorizeUpload(alias: string, actor: ShareActor | null, now = this.clock()) {
    return this.upload('alias', alias, actor, now)
  }
  authorizeUploadId(id: string, actor: ShareActor | null, now = this.clock()) {
    return this.upload('id', id, actor, now)
  }
}
