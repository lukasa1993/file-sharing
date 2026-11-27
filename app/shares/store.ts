import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { Clock, Effect, Option, Semaphore } from 'effect'
import { asAppError, attempt, runTask } from '../effects.ts'
import { parseBatch, parseShareInput, type ShareInput } from './input.ts'
export type { ShareInput } from './input.ts'
import {
  AppError,
  type Action,
  type Entry,
  type Guard,
  type ResourceRef,
  type User,
} from '../contracts'
import { pinMatchesVersion } from '../filesystem/resolver.ts'
import type { Filesystem } from '../filesystem'
import type { Identity } from '../identity'

export type ShareAccess = 'public' | 'password' | 'authenticated'
export type ShareKind = 'download' | 'upload'
export type ShareMode = 'direct' | 'landing'
export type ShareSession = {
  user: User | null
  sessionId: string | null
  csrf: string
}
type Target = {
  ref: ResourceRef
  kind: Entry['kind']
  name: string
  version: string
}
export type Share = {
  id: string
  alias: string
  ownerId: string
  revision: number
  kind: ShareKind
  access: ShareAccess
  mode: ShareMode
  targets: Target[]
  enabled: boolean
  expiresAt: string | null
  maxBytes: number | null
  maxDownloads: number | null
  bytesPerSecond: number | null
  latestAtPath: boolean
  passwordHash: string | null
}
type Row = {
  data: string
  broken: number
  lastAccess: string | null
  bytesServed: number
  requests: number
}
export type ShareDto = Omit<Share, 'targets' | 'passwordHash'> & {
  targets: ResourceRef[]
  targetNames: string[]
  broken: boolean
  lastAccess: string | null
  bytesServed: number
  requests: number
}
const names = new Set([
  '_',
  'login',
  'logout',
  'admin',
  'api',
  'assets',
  'healthz',
  'readyz',
  'favicon',
  'robots',
  'settings',
  'shares',
  'uploads',
  'files',
])
const missing = () => new AppError(404, 'Share unavailable.')
const bad = (text: string) => new AppError(400, text)
export const keyForSession = (id: string) =>
  createHash('sha256').update(id).digest('hex')
export const sameRef = (a: ResourceRef, b: ResourceRef) =>
  a.segments.length === b.segments.length && contains(a, b)
export const contains = (base: ResourceRef, item: ResourceRef) =>
  base.mountId === item.mountId &&
  base.segments.every((segment, index) => item.segments[index] === segment)

function optionalPositive(value: number | null | undefined) {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw bad('Limits must be positive whole numbers.')
  return value
}
function validAlias(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) ||
    names.has(value)
  )
    throw bad('Choose an available lowercase alias of up to 64 characters.')
  return value
}
export function validateSegment(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    /[\/\\\0]/.test(value) ||
    Buffer.byteLength(value) > 255
  )
    throw bad('Invalid path segment.')
}
function asDto(s: Share, row: Row): ShareDto {
  const { passwordHash, targets, ...publicFields } = s
  return {
    ...publicFields,
    targets: targets.map((t) => t.ref),
    targetNames: targets.map((t) => t.name),
    broken: !!row.broken,
    lastAccess: row.lastAccess,
    bytesServed: row.bytesServed,
    requests: row.requests,
  }
}

export type ShareFilesystem = Pick<Filesystem, 'stat' | 'list'>
export type ShareIdentity = Pick<
  Identity,
  | 'allowed'
  | 'getUser'
  | 'sessionActive'
  | 'consumePasswordAttempt'
  | 'bandwidthBudget'
>
const syncTask = <A>(run: () => A) =>
  Effect.try({ try: run, catch: asAppError })
export class ShareStore {
  protected readonly passwordSlots = Semaphore.makeUnsafe(4)
  constructor(
    protected db: Database,
    protected fs: ShareFilesystem,
    protected identity: ShareIdentity,
    protected readonly clock: Clock.Clock = Effect.runSync(
      Clock.clockWith(Effect.succeed),
    ),
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS shares(
        id TEXT PRIMARY KEY, alias TEXT UNIQUE COLLATE NOCASE NOT NULL, owner TEXT NOT NULL,
        data TEXT NOT NULL, broken INTEGER NOT NULL DEFAULT 0, lastAccess TEXT,
        bytesServed INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS ix_shares_owner ON shares(owner);
      CREATE TABLE IF NOT EXISTS share_grants(
        share TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
        recipient TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(share,revision,recipient)
      );
      CREATE TABLE IF NOT EXISTS download_leases(
        share TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
        recipient TEXT NOT NULL, version TEXT NOT NULL, expires INTEGER NOT NULL,
        PRIMARY KEY(share,revision,recipient,version)
      );
      CREATE TABLE IF NOT EXISTS share_lease_counts(
        share TEXT PRIMARY KEY REFERENCES shares(id) ON DELETE CASCADE, used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS share_alias_history(
        share TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, alias TEXT NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY(share,revision)
      );
      CREATE TABLE IF NOT EXISTS share_history(
        sequence INTEGER PRIMARY KEY, share TEXT NOT NULL, actor TEXT NOT NULL,
        event TEXT NOT NULL, at TEXT NOT NULL
      )
    `)
  }
  protected audit(share: string, actor: string, event: string) {
    this.db
      .query('INSERT INTO share_history(share,actor,event,at) VALUES(?,?,?,?)')
      .run(
        share,
        actor,
        event,
        new Date(this.clock.currentTimeMillisUnsafe()).toISOString(),
      )
    this.db
      .query(
        'DELETE FROM share_history WHERE sequence <= (SELECT max(sequence)-10000 FROM share_history)',
      )
      .run()
  }
  protected row(id: string): Row {
    const row = this.db
      .query<Row, [string]>('SELECT * FROM shares WHERE id=?')
      .get(id)
    if (!row) throw missing()
    return row
  }
  protected byAlias(alias: string): Share {
    const row = this.db
      .query<{ data: string }, [string]>(
        'SELECT data FROM shares WHERE alias=? AND broken=0',
      )
      .get(alias)
    if (!row || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(alias)) throw missing()
    return JSON.parse(row.data)
  }
  protected byId(id: string): Share {
    return JSON.parse(this.row(id).data)
  }
  list(user: User): ShareDto[] {
    const current = this.identity.getUser(user.id)
    if (!current) throw missing()
    const rows = current.admin
      ? this.db.query<Row, []>('SELECT * FROM shares ORDER BY alias').all()
      : this.db
          .query<Row, [string]>(
            'SELECT * FROM shares WHERE owner=? ORDER BY alias',
          )
          .all(user.id)
    return rows.map((row) => this.summary(current, JSON.parse(row.data), row))
  }
  private summary(actor: User, share: Share, row: Row) {
    const dto = asDto(share, row)
    const owner = this.identity.getUser(share.ownerId)
    const visible = share.targets.filter(
      (t) =>
        this.identity.allowed(actor, 'share', t.ref) &&
        this.identity.allowed(
          actor,
          share.kind === 'upload'
            ? 'upload'
            : t.kind === 'directory'
              ? 'list'
              : 'read',
          t.ref,
        ),
    )
    const ownerLostAccess =
      !owner ||
      share.targets.some(
        (t) =>
          !this.identity.allowed(owner, 'share', t.ref) ||
          !this.identity.allowed(
            owner,
            share.kind === 'upload'
              ? 'upload'
              : t.kind === 'directory'
                ? 'list'
                : 'read',
            t.ref,
          ),
      )
    const remaining = share.expiresAt
      ? Date.parse(share.expiresAt) - this.clock.currentTimeMillisUnsafe()
      : Infinity
    const status = !share.enabled
      ? 'Disabled'
      : remaining <= 0
        ? 'Expired'
        : row.broken || ownerLostAccess
          ? 'Unavailable'
          : remaining <= 86400000
            ? 'Expires soon'
            : 'Active'
    return {
      ...dto,
      targets: visible.map((t) => t.ref),
      targetNames: visible.map((t) => t.name),
      status,
    }
  }
  protected manageable(id: string, actor: User): Share {
    const s = this.byId(id)
    const currentActor = this.identity.getUser(actor.id)
    if (!currentActor || (s.ownerId !== actor.id && !currentActor.admin))
      throw missing()
    return s
  }
  protected guardFor(ownerId: string): Guard {
    return (action, ref) => {
      const current = this.identity.getUser(ownerId)
      if (!current || !this.identity.allowed(current, action, ref))
        throw missing()
    }
  }
  protected requireActive(s: Share) {
    if (
      !s.enabled ||
      (s.expiresAt &&
        Date.parse(s.expiresAt) <= this.clock.currentTimeMillisUnsafe()) ||
      !this.identity.getUser(s.ownerId)
    )
      throw missing()
  }
  private selectTargets(
    refs: ResourceRef[] | undefined,
    kind: ShareKind,
    ownerId: string,
  ) {
    if (
      !refs?.length ||
      refs.length > 100 ||
      (kind === 'upload' && refs.length !== 1)
    )
      return Effect.fail(bad('Choose valid share targets.'))
    const guard = this.guardFor(ownerId)
    return Effect.forEach(
      refs,
      (ref, index) =>
        attempt(async () => {
          if (!ref.mountId || ref.segments.length > 128)
            throw bad('Invalid share target.')
          ref.segments.forEach(validateSegment)
          if (
            refs
              .slice(0, index)
              .some((prior) => contains(prior, ref) || contains(ref, prior))
          )
            throw bad('Select each item once without overlapping folders.')
          guard('share', ref)
          const owner = this.identity.getUser(ownerId)
          if (!owner) throw missing()
          const action =
            kind === 'upload'
              ? 'upload'
              : this.identity.allowed(owner, 'read', ref)
                ? 'read'
                : 'list'
          const entry = await this.fs.stat(ref, guard, action)
          if (kind === 'upload' && entry.kind !== 'directory')
            throw bad('An upload request needs a folder.')
          guard(
            kind === 'upload'
              ? 'upload'
              : entry.kind === 'file'
                ? 'read'
                : 'list',
            ref,
          )
          return {
            ref,
            name: entry.name,
            kind: entry.kind,
            version: entry.version,
          }
        }),
      { concurrency: 4 },
    )
  }
  protected passwordWork<A>(f: () => Promise<A>) {
    return Effect.flatMap(
      this.passwordSlots.withPermitsIfAvailable(1)(attempt(f)),
      (result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : Effect.fail(
              new AppError(429, 'Too many password requests. Try again later.'),
            ),
    )
  }
  save(actor: User, value: unknown, id?: string): Promise<ShareDto> {
    return runTask(this.saveEffect(actor, value, id))
  }
  saveEffect(actor: User, value: unknown, id?: string) {
    const self = this
    return Effect.gen(function* () {
      const input = yield* syncTask(() => parseShareInput(value))
      const old = id
        ? yield* syncTask(() => self.manageable(id, actor))
        : undefined
      const kind = input.kind ?? old?.kind ?? 'download'
      const access = input.access ?? old?.access ?? 'authenticated'
      const mode = input.mode ?? old?.mode ?? 'direct'
      const ownerId = input.ownerId ?? old?.ownerId ?? actor.id
      if (ownerId !== (old?.ownerId ?? actor.id) && !actor.admin)
        return yield* Effect.fail(
          new AppError(403, 'Owner transfer requires an administrator.'),
        )
      if (!self.identity.getUser(ownerId))
        return yield* Effect.fail(bad('Owner unavailable.'))
      const suppliedTargets = input.targets
      const needTargetCheck =
        !old ||
        suppliedTargets !== undefined ||
        kind !== old.kind ||
        (input.latestAtPath !== undefined &&
          input.latestAtPath !== old.latestAtPath) ||
        ownerId !== old.ownerId ||
        input.enabled === true
      const targets = needTargetCheck
        ? yield* self.selectTargets(
            suppliedTargets ?? old?.targets.map((t) => t.ref),
            kind,
            ownerId,
          )
        : old.targets
      const exposing =
        !old ||
        old.access !== 'public' ||
        suppliedTargets !== undefined ||
        (input.alias !== undefined && input.alias !== old.alias)
      if (access === 'public' && exposing && input.confirmPublic !== true)
        return yield* Effect.fail(
          bad('Confirm that anyone with this link can access the share.'),
        )
      let passwordHash = old?.passwordHash ?? null
      if (access === 'password') {
        const password = input.password
        if (password !== undefined) {
          if (!password || Buffer.byteLength(password) > 512)
            return yield* Effect.fail(bad('Provide a valid share password.'))
          passwordHash = yield* self.passwordWork(() =>
            Bun.password.hash(password, {
              algorithm: 'argon2id',
              memoryCost: 19456,
              timeCost: 2,
            }),
          )
        }
        if (!passwordHash)
          return yield* Effect.fail(bad('A password is required.'))
      } else passwordHash = null
      const expiresAt =
        input.expiresAt === undefined
          ? (old?.expiresAt ?? null)
          : input.expiresAt
      if (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt)))
        return yield* Effect.fail(bad('Provide a valid expiration date.'))
      return yield* syncTask(() =>
        self.persist(actor, input, old, needTargetCheck, {
          ownerId,
          kind,
          access,
          mode,
          targets,
          passwordHash,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        }),
      )
    }).pipe(Effect.withSpan('share.save'))
  }
  private persist(
    actor: User,
    input: ShareInput,
    old: Share | undefined,
    needTargetCheck: boolean,
    fields: Pick<
      Share,
      | 'ownerId'
      | 'kind'
      | 'access'
      | 'mode'
      | 'targets'
      | 'passwordHash'
      | 'expiresAt'
    >,
  ): ShareDto {
    const s: Share = {
      id: old?.id ?? randomUUID(),
      ...fields,
      revision: (old?.revision ?? 0) + 1,
      alias: validAlias(
        input.alias === '' || input.alias == null
          ? (old?.alias ?? randomBytes(16).toString('hex'))
          : input.alias,
      ),
      enabled: input.enabled ?? old?.enabled ?? true,
      latestAtPath: input.latestAtPath ?? old?.latestAtPath ?? false,
      maxBytes: optionalPositive(
        input.maxBytes === undefined ? old?.maxBytes : input.maxBytes,
      ),
      maxDownloads: optionalPositive(
        input.maxDownloads === undefined
          ? old?.maxDownloads
          : input.maxDownloads,
      ),
      bytesPerSecond: optionalPositive(
        input.bytesPerSecond === undefined
          ? old?.bytesPerSecond
          : input.bytesPerSecond,
      ),
    }
    if (s.maxBytes && s.kind !== 'upload')
      throw bad('The byte budget applies to upload requests.')
    if (s.maxDownloads && s.kind !== 'download')
      throw bad('The transfer limit applies to downloads.')
    this.db
      .transaction(() => {
        const currentActor = this.identity.getUser(actor.id)
        if (
          !currentActor ||
          (!currentActor.admin &&
            (fields.ownerId !== actor.id || (old && old.ownerId !== actor.id)))
        )
          throw missing()
        for (const target of fields.targets) {
          if (!this.identity.allowed(currentActor, 'share', target.ref))
            throw missing()
        }
        if (old && this.byId(old.id).revision !== old.revision)
          throw new AppError(409, 'The share changed. Refresh and try again.')
        if (
          this.db
            .query('SELECT 1 FROM shares WHERE alias=? AND id<>?')
            .get(s.alias, s.id)
        )
          throw new AppError(409, 'Alias unavailable.')
        if (old) {
          this.db
            .query(
              'UPDATE shares SET alias=?,owner=?,data=?,broken=CASE WHEN ? THEN 0 ELSE broken END WHERE id=?',
            )
            .run(
              s.alias,
              s.ownerId,
              JSON.stringify(s),
              needTargetCheck ? 1 : 0,
              s.id,
            )
          this.db.query('DELETE FROM share_grants WHERE share=?').run(s.id)
          this.db.query('DELETE FROM download_leases WHERE share=?').run(s.id)
        } else {
          this.db
            .query('INSERT INTO shares(id,alias,owner,data) VALUES(?,?,?,?)')
            .run(s.id, s.alias, s.ownerId, JSON.stringify(s))
        }
        if (old?.alias !== s.alias) {
          this.db
            .query(
              'INSERT INTO share_alias_history(share,revision,alias,at) VALUES(?,?,?,?)',
            )
            .run(
              s.id,
              s.revision,
              s.alias,
              new Date(this.clock.currentTimeMillisUnsafe()).toISOString(),
            )
          this.db
            .query(
              'DELETE FROM share_alias_history WHERE share=? AND revision<(SELECT revision FROM share_alias_history WHERE share=? ORDER BY revision DESC LIMIT 1 OFFSET 49)',
            )
            .run(s.id, s.id)
        }
        this.audit(s.id, actor.id, old ? 'update' : 'create')
      })
      .immediate()
    return asDto(s, this.row(s.id))
  }
  details(actor: User, id: string) {
    const share = this.manageable(id, actor)
    const history = this.db
      .query<{ alias: string; at: string }, [string]>(
        'SELECT alias,at FROM share_alias_history WHERE share=? ORDER BY revision DESC',
      )
      .all(id)
    const usedTransfers =
      this.db
        .query<{ used: number }, [string]>(
          'SELECT used FROM share_lease_counts WHERE share=?',
        )
        .get(id)?.used ?? 0
    return {
      ...this.summary(actor, share, this.row(id)),
      history,
      usedTransfers,
    }
  }

  batch(actor: User, input: unknown) {
    const { operation, ids } = parseBatch(input)
    // Validate the entire selection inside the same SQLite write transaction.
    this.db
      .transaction(() => {
        const selected = ids.map((id) => this.manageable(id, actor))
        for (const s of selected) {
          if (operation === 'revoke') {
            this.db.query('DELETE FROM shares WHERE id=?').run(s.id)
          } else {
            this.db.query('UPDATE shares SET data=? WHERE id=?').run(
              JSON.stringify({
                ...s,
                enabled: false,
                revision: s.revision + 1,
              }),
              s.id,
            )
            this.db.query('DELETE FROM share_grants WHERE share=?').run(s.id)
            this.db.query('DELETE FROM download_leases WHERE share=?').run(s.id)
          }
          this.audit(s.id, actor.id, operation)
        }
      })
      .immediate()
  }
  remove(actor: User, id: string) {
    this.manageable(id, actor)
    this.db
      .transaction(() => {
        this.db.query('DELETE FROM shares WHERE id=?').run(id)
        this.audit(id, actor.id, 'revoke')
      })
      .immediate()
  }
  protected authorize(s: Share, access: ShareSession) {
    this.requireActive(s)
    if (
      s.access === 'authenticated' &&
      (!access.user ||
        !access.sessionId ||
        !this.identity.sessionActive(access.sessionId) ||
        !this.identity.getUser(access.user.id))
    )
      throw new AppError(401, 'Sign in to open this share.')
    if (
      s.access === 'password' &&
      !(
        access.sessionId &&
        this.identity.sessionActive(access.sessionId) &&
        this.db
          .query(
            'SELECT 1 FROM share_grants WHERE share=? AND revision=? AND recipient=? AND expires>?',
          )
          .get(
            s.id,
            s.revision,
            keyForSession(access.sessionId),
            this.clock.currentTimeMillisUnsafe(),
          )
      )
    )
      throw new AppError(401, 'A share password is required.')
  }
  protected scopedGuard(s: Share, access: ShareSession): Guard {
    const ownerGuard = this.guardFor(s.ownerId)
    const guard: Guard = (action, ref) => {
      const current = this.byId(s.id)
      if (current.revision !== s.revision) throw missing()
      this.authorize(current, access)
      const target = s.targets.find(
        (t) =>
          sameRef(t.ref, ref) ||
          (t.kind === 'directory' && contains(t.ref, ref)),
      )
      if (!target) throw missing()
      ownerGuard('share', target.ref)
      if (!sameRef(target.ref, ref)) ownerGuard('share', ref)
      if (
        s.kind === 'download'
          ? action !== 'read' && action !== 'list'
          : action !== 'upload' && action !== 'create'
      )
        throw missing()
      ownerGuard(action, ref)
    }
    // The filesystem checks these inode pins inside its mount lock, including upload publication.
    const targetPins = s.latestAtPath
      ? []
      : s.targets.map((t) => ({ ref: t.ref, version: t.version }))
    return Object.assign(guard, { targetPins })
  }
  protected validateEntry(s: Share, entry: Entry) {
    const target = s.targets.find((t) => sameRef(t.ref, entry.ref))
    if (!target) return
    const sameIdentity = pinMatchesVersion(
      target.version,
      entry.version,
      target.kind === 'directory',
    )
    if (target.kind !== entry.kind || (!s.latestAtPath && !sameIdentity)) {
      this.db.query('UPDATE shares SET broken=1 WHERE id=?').run(s.id)
      throw missing()
    }
  }
  protected async targetEntry(s: Share, t: Target, guard: Guard) {
    const action: Action =
      s.kind === 'upload' ? 'upload' : t.kind === 'directory' ? 'list' : 'read'
    guard(action, t.ref)
    let entry: Entry
    try {
      entry = await this.fs.stat(t.ref, guard, action)
    } catch (error) {
      if (error instanceof AppError && error.status === 404)
        this.db.query('UPDATE shares SET broken=1 WHERE id=?').run(s.id)
      throw missing()
    }
    this.validateEntry(s, entry)
    return entry
  }
  protected recordStart(s: Share, session: ShareSession, version: string) {
    const active = this.byId(s.id)
    if (active.revision !== s.revision) throw missing()
    this.authorize(active, session)
    this.db
      .transaction(() => {
        if (s.maxDownloads !== null) {
          if (!session.sessionId)
            throw new AppError(
              403,
              'Enable cookies to use a limited download link.',
            )
          const recipient = keyForSession(session.sessionId)
          const now = this.clock.currentTimeMillisUnsafe()
          this.db
            .query('DELETE FROM download_leases WHERE share=? AND expires<=?')
            .run(s.id, now)
          if (
            !this.db
              .query(
                'SELECT 1 FROM download_leases WHERE share=? AND revision=? AND recipient=? AND version=?',
              )
              .get(s.id, s.revision, recipient, version)
          ) {
            const count =
              this.db
                .query<{ used: number }, [string]>(
                  'SELECT used FROM share_lease_counts WHERE share=?',
                )
                .get(s.id)?.used ?? 0
            if (count >= s.maxDownloads)
              throw new AppError(410, 'Transfer limit reached.')
            this.db
              .query('INSERT INTO download_leases VALUES(?,?,?,?,?)')
              .run(s.id, s.revision, recipient, version, now + 3600_000)
            this.db
              .query(
                'INSERT INTO share_lease_counts VALUES(?,1) ON CONFLICT(share) DO UPDATE SET used=used+1',
              )
              .run(s.id)
          }
        }
        this.db
          .query(
            'UPDATE shares SET requests=requests+1,lastAccess=? WHERE id=?',
          )
          .run(
            new Date(this.clock.currentTimeMillisUnsafe()).toISOString(),
            s.id,
          )
      })
      .immediate()
  }
}
