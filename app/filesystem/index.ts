import { PublicationJournal } from './publication.ts'
import { RetirementJournal } from './retirement.ts'
import { Clock, Context, Effect, Layer, Option, Semaphore } from 'effect'
import { attempt, runTask } from '../effects.ts'
import type { Database } from 'bun:sqlite'
import { constants as C, type BigIntStats } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  rename,
  rmdir,
  statfs,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { extname } from 'node:path'
import {
  AppError,
  type AppConfig,
  type Action,
  type Entry,
  type Guard,
  type Mount,
  type ResourceRef,
} from '../contracts.ts'
import {
  Resolver,
  type Root,
  asEntry,
  checkRef,
  child,
  code,
  fault,
  fdPath,
  identity,
  leaf,
  names,
  parent,
  storageError,
  safeStat,
  version,
  pinMatches,
  treeLimit,
} from './resolver.ts'

export type Conflict = 'reject' | 'skip' | 'rename' | 'overwrite'
export type Operation = 'copy' | 'move' | 'rename' | 'delete' | 'trash'
export type CopyProgress = {
  ref: ResourceRef
  phase: 'copying' | 'verifying'
  bytes: number
  total: number
}
export type TrashItem = { id: string; ref: ResourceRef; deletedAt: number }
type TrashRow = {
  id: string
  mount: string
  path: string
  deleted: number
  state: string
  identity: string
}
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function requireId(id: string) {
  if (!uuidPattern.test(id)) fault(400, 'Invalid operation ID')
}
function descendant(base: ResourceRef, ref: ResourceRef) {
  return (
    base.mountId === ref.mountId &&
    base.segments.every((part, i) => ref.segments[i] === part)
  )
}
function isDenied(e: unknown) {
  return e instanceof AppError && [403, 404].includes(e.status)
}
function permit(guard: Guard, action: Action, ref: ResourceRef) {
  try {
    guard(action, ref)
    return true
  } catch (e) {
    if (isDenied(e)) return false
    throw e
  }
}
async function exists(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true })
  } catch (e) {
    if (code(e) === 'ENOENT') return null
    throw e
  }
}
async function withHandle<T>(h: FileHandle, fn: (h: FileHandle) => Promise<T>) {
  try {
    return await fn(h)
  } finally {
    await h.close()
  }
}

// Exclusive queues are acquired in stable mount order. An HTTP download releases the
// queue as soon as its pinned descriptor is open, before any bytes are streamed.
class MountQueues {
  private readonly admission = Semaphore.makeUnsafe(256)
  private readonly locks: Map<string, Semaphore.Semaphore>
  constructor(mounts: Mount[]) {
    this.locks = new Map(mounts.map((m) => [m.id, Semaphore.makeUnsafe(1)]))
  }
  task<T>(ids: string[], job: Effect.Effect<T, AppError>) {
    // A pending admission may be interrupted. Once native I/O starts it must
    // settle before Effect releases the mount's lock and resource scope.
    let locked = Effect.uninterruptible(job)
    for (const id of [...new Set(ids)].sort().reverse()) {
      const lock = this.locks.get(id)
      if (!lock) return Effect.fail(new AppError(404, 'Unknown storage'))
      locked = Semaphore.withPermit(lock, locked)
    }
    return Effect.flatMap(
      Semaphore.withPermitsIfAvailable(this.admission, 1)(locked),
      (result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : Effect.fail(new AppError(503, 'Storage is busy')),
    )
  }
  run<T>(ids: string[], job: () => Promise<T>) {
    return runTask(this.task(ids, attempt(job, storageError)))
  }
}

export class Filesystem {
  private readonly publication: PublicationJournal
  private readonly retirements: RetirementJournal
  private resolver: Resolver
  private readonly activeSearches = new Set<string>()
  private readonly searchCounts = new Map<string, number>()
  private searchMinute = -1
  private searchRequests = 0
  private readonly queues: MountQueues
  constructor(
    private mounts: Mount[],
    private db: Database,
    privateLocations?: AppConfig['privateLocations'],
  ) {
    this.resolver = new Resolver(mounts, privateLocations)
    this.queues = new MountQueues(mounts)
    this.publication = new PublicationJournal(db, this.resolver)
    this.retirements = new RetirementJournal(db, this.resolver)
    db.exec(`CREATE TABLE IF NOT EXISTS fs_mount_state(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS fs_retention(mount TEXT PRIMARY KEY, duration INTEGER NOT NULL CHECK(duration>=0));
      CREATE TABLE IF NOT EXISTS fs_copy_stages(id TEXT PRIMARY KEY,mount TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fs_trash(id TEXT PRIMARY KEY, mount TEXT NOT NULL, path TEXT NOT NULL,
        deleted INTEGER NOT NULL, state TEXT NOT NULL, identity TEXT NOT NULL);`)
  }
  isEnabled(id: string) {
    return (
      this.mounts.some((m) => m.id === id) &&
      this.db
        .query<{ enabled: number }, [string]>(
          'SELECT enabled FROM fs_mount_state WHERE id=?',
        )
        .get(id)?.enabled !== 0
    )
  }
  setEnabled(id: string, enabled: boolean) {
    if (!this.mounts.some((m) => m.id === id)) fault(404, 'Unknown storage')
    this.db
      .query(
        'INSERT INTO fs_mount_state(id,enabled) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled',
      )
      .run(id, +enabled)
  }
  private rootTask<T>(
    id: string,
    write: boolean,
    work: (r: Root) => Promise<T>,
  ) {
    return Effect.acquireUseRelease(
      attempt(async () => {
        if (!this.isEnabled(id)) fault(503, 'Storage unavailable')
        return this.resolver.openRoot(id, write)
      }, storageError),
      (root) =>
        attempt(async () => {
          if (!root.mount.readOnly) await this.reconcile(root)
          return work(root)
        }, storageError),
      (root) => attempt(() => root.h.close(), storageError),
    )
  }
  private root<T>(id: string, write: boolean, work: (r: Root) => Promise<T>) {
    return runTask(this.rootTask(id, write, work))
  }
  private inspectTask<T>(
    ref: ResourceRef,
    work: (r: Root) => Promise<T>,
    write = false,
  ) {
    return Effect.suspend(() => {
      try {
        checkRef(ref)
      } catch (e) {
        return Effect.fail(storageError(e))
      }
      return this.queues.task(
        [ref.mountId],
        this.rootTask(ref.mountId, write, work),
      )
    })
  }
  private inspect<T>(
    ref: ResourceRef,
    work: (r: Root) => Promise<T>,
    write = false,
  ) {
    return runTask(this.inspectTask(ref, work, write))
  }
  private pinCheck(ref: ResourceRef, guard?: Guard) {
    const pins = guard?.targetPins?.filter((pin) => descendant(pin.ref, ref))
    if (!pins?.length) return undefined
    return async (depth: number, handle: FileHandle) => {
      for (const pin of pins) {
        if (pin.ref.segments.length !== depth) continue
        const meta = await handle.stat({ bigint: true })
        if (!pinMatches(pin.version, meta))
          fault(404, 'Shared entry unavailable')
      }
    }
  }
  private async opened(
    root: Root,
    ref: ResourceRef,
    guard?: Guard,
  ): Promise<FileHandle> {
    const verify = this.pinCheck(ref, guard)
    if (!ref.segments.length) return this.resolver.directory(root, [], verify)
    return withHandle(
      await this.resolver.directory(root, parent(ref).segments, verify),
      async (dir) => {
        const handle = await this.resolver.checked(
          root,
          fdPath(dir) + '/' + leaf(ref),
        )
        try {
          await verify?.(ref.segments.length, handle)
          return handle
        } catch (e) {
          await handle.close()
          throw e
        }
      },
    )
  }
  statTask(ref: ResourceRef, guard: Guard, action: Action = 'list') {
    return this.inspectTask(ref, async (r) => {
      guard(action, ref)
      return withHandle(await this.opened(r, ref, guard), async (h) =>
        asEntry(ref, await h.stat({ bigint: true }), r.mount.label),
      )
    })
  }
  stat(
    ref: ResourceRef,
    guard: Guard,
    action: Action = 'list',
  ): Promise<Entry> {
    return runTask(this.statTask(ref, guard, action))
  }
  openReadTask(ref: ResourceRef, guard: Guard) {
    return Effect.suspend(() => {
      try {
        checkRef(ref)
      } catch (e) {
        return Effect.fail(storageError(e))
      }
      return this.queues.task(
        [ref.mountId],
        this.rootTask(ref.mountId, false, async (r) => {
          guard('read', ref)
          const h = await this.opened(r, ref, guard)
          try {
            const entry = asEntry(
              ref,
              await h.stat({ bigint: true }),
              r.mount.label,
            )
            if (entry.kind !== 'file') fault(409, 'Choose a regular file')
            guard('read', ref)
            return { handle: h, entry }
          } catch (e) {
            await h.close()
            throw e
          }
        }),
      )
    })
  }
  openRead(ref: ResourceRef, guard: Guard) {
    return runTask(this.openReadTask(ref, guard))
  }
  openReadScoped(ref: ResourceRef, guard: Guard) {
    return Effect.acquireRelease(this.openReadTask(ref, guard), (file) =>
      Effect.promise(() => file.handle.close()),
    )
  }
  private async entries(
    r: Root,
    ref: ResourceRef,
    guard: Guard,
    visit: () => void,
  ): Promise<Entry[]> {
    guard('list', ref)
    return withHandle(
      await this.resolver.directory(r, ref.segments, this.pinCheck(ref, guard)),
      async (h) => {
        const result: Entry[] = []
        for await (const name of names(h, true)) {
          visit()
          const sub = child(ref, name)
          if (!permit(guard, 'list', sub)) continue
          try {
            await withHandle(
              await this.resolver.checked(r, fdPath(h) + '/' + name),
              async (f) => {
                await this.pinCheck(sub, guard)?.(sub.segments.length, f)
                result.push(
                  asEntry(sub, await f.stat({ bigint: true }), r.mount.label),
                )
              },
            )
          } catch (e) {
            if (
              !isDenied(e) &&
              !['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes(code(e) ?? '')
            )
              throw e
          }
        }
        return result
      },
    )
  }
  listTask(ref: ResourceRef, guard: Guard) {
    return this.inspectTask(ref, (r) => this.entries(r, ref, guard, () => {}))
  }
  list(ref: ResourceRef, guard: Guard) {
    return runTask(this.listTask(ref, guard))
  }
  searchTask(
    ref: ResourceRef,
    query: string,
    guard: Guard,
    actor: string,
    signal?: AbortSignal,
  ) {
    if (!query.trim() || query.length > 256)
      fault(400, 'Enter a filename search')
    const admission = Effect.flatMap(Clock.currentTimeMillis, (now) => {
      const minute = Math.floor(now / 60_000)
      if (minute !== this.searchMinute) {
        this.searchMinute = minute
        this.searchRequests = 0
        this.searchCounts.clear()
      }
      const actorRequests = this.searchCounts.get(actor) ?? 0
      if (this.activeSearches.has(actor) || actorRequests >= 12)
        return Effect.fail(
          new AppError(429, 'Search limit reached. Try again shortly.'),
        )
      if (this.activeSearches.size >= 2 || this.searchRequests >= 120)
        return Effect.fail(
          new AppError(
            429,
            'Other searches are in progress. Try again shortly.',
          ),
        )
      this.activeSearches.add(actor)
      this.searchCounts.set(actor, actorRequests + 1)
      this.searchRequests++
      return Effect.void
    })
    return Effect.acquireUseRelease(
      admission,
      () =>
        Effect.gen({ self: this }, function* () {
          const pending = [ref]
          const matches: Entry[] = []
          const needle = query.toLowerCase()
          let scanned = 0
          while (pending.length) {
            const directory = pending.pop()
            if (!directory) break
            // Yield the mount lock between directories so ordinary file operations can proceed.
            const items = yield* this.inspectTask(directory, (root) =>
              this.entries(root, directory, guard, () => {
                if (signal?.aborted) fault(409, 'Search cancelled')
                if (++scanned > treeLimit)
                  fault(413, 'Search limit exceeded. Choose a smaller folder.')
              }),
            )
            for (const item of items) {
              if (item.name.toLowerCase().includes(needle)) matches.push(item)
              if (item.kind === 'directory') pending.push(item.ref)
            }
          }
          return matches
        }),
      () =>
        Effect.sync(() => {
          this.activeSearches.delete(actor)
        }),
    )
  }
  search(
    ref: ResourceRef,
    query: string,
    guard: Guard,
    actor = 'local',
    signal?: AbortSignal,
  ) {
    return runTask(
      this.searchTask(ref, query, guard, actor, signal),
      signal ? { signal } : undefined,
    )
  }
  space(mountId: string) {
    return this.queues.run([mountId], () =>
      this.root(mountId, false, async (r) => {
        const s = await statfs(fdPath(r.h), { bigint: true })
        return {
          free: Number(s.bavail * s.bsize),
          total: Number(s.blocks * s.bsize),
        }
      }),
    )
  }
  createDir(ref: ResourceRef, guard: Guard) {
    return this.inspect(
      ref,
      async (r) => {
        const p = parent(ref)
        guard('create', p)
        guard('create', ref)
        await withHandle(
          await this.resolver.directory(r, p.segments),
          async (h) => {
            guard('create', p)
            guard('create', ref)
            await mkdir(fdPath(h) + '/' + leaf(ref), { mode: 0o750 })
            await h.sync()
          },
        )
      },
      true,
    )
  }

  private async stageParent(root: Root, ref: ResourceRef, guard: Guard) {
    const p = parent(ref)
    guard('upload', ref)
    const verify = this.pinCheck(ref, guard)
    let cur: ResourceRef = { mountId: ref.mountId, segments: [] }
    let h = await this.resolver.directory(root, [], verify)
    try {
      for (const name of p.segments) {
        const next = child(cur, name),
          path = fdPath(h) + '/' + name
        if (!(await exists(path))) {
          if (
            guard.targetPins?.some(
              (pin) => descendant(next, pin.ref) && descendant(pin.ref, ref),
            )
          )
            fault(404, 'Shared directory unavailable')
          guard('create', cur)
          guard('create', next)
          await mkdir(path, { mode: 0o750 }).catch((e) => {
            if (code(e) !== 'EEXIST') throw e
          })
          await h.sync()
        }
        const nextHandle = await this.resolver.checked(root, path, true)
        await h.close()
        h = nextHandle
        cur = next
        await verify?.(cur.segments.length, h)
      }
      guard('upload', ref)
      return h
    } catch (e) {
      await h.close()
      throw e
    }
  }
  createStage(ref: ResourceRef, id: string, guard: Guard) {
    requireId(id)
    return this.inspect(
      ref,
      async (r) => {
        await (await this.stageParent(r, ref, guard)).close()
        return withHandle(
          await this.resolver.private(r, 'stage'),
          async (dir) => {
            const h = await open(
              fdPath(dir) + '/' + id,
              C.O_CREAT | C.O_EXCL | C.O_RDWR | C.O_NOFOLLOW,
              0o600,
            )
            try {
              await dir.sync()
              return h
            } catch (e) {
              await h.close()
              throw e
            }
          },
        )
      },
      true,
    )
  }
  openStage(mountId: string, id: string) {
    requireId(id)
    return this.queues.run([mountId], () =>
      this.root(mountId, true, async (r) =>
        withHandle(await this.resolver.private(r, 'stage'), async (d) => {
          const h = await open(
            fdPath(d) + '/' + id,
            C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK,
          )
          try {
            const s = await h.stat({ bigint: true })
            safeStat(s)
            if (!s.isFile() || s.dev !== r.device)
              fault(409, 'Stage unavailable')
            return h
          } catch (e) {
            await h.close()
            throw e
          }
        }),
      ),
    )
  }
  discardStage(mountId: string, id: string) {
    requireId(id)
    return this.queues.run([mountId], () =>
      this.root(mountId, true, async (r) =>
        withHandle(await this.resolver.private(r, 'stage'), async (d) => {
          await unlink(fdPath(d) + '/' + id).catch((e) => {
            if (code(e) !== 'ENOENT') throw e
          })
          await d.sync()
        }),
      ),
    )
  }
  private async destination(
    root: Root,
    dir: FileHandle,
    ref: ResourceRef,
    policy: Conflict,
  ): Promise<{ ref: ResourceRef; existing: BigIntStats | null } | null> {
    if (!['reject', 'skip', 'overwrite', 'rename'].includes(policy))
      fault(400, 'Unknown conflict policy')
    const name = leaf(ref)
    const extension = extname(name),
      stem = name.slice(0, name.length - extension.length)
    const base = parent(ref)
    for (let i = 0; i < 1000; i++) {
      const target = i
        ? child(base, stem + ' (' + (i + 1) + ')' + extension)
        : ref
      const path = fdPath(dir) + '/' + leaf(target),
        existing = await exists(path)
      if (!existing) return { ref: target, existing }
      if (policy === 'skip') return null
      if (policy === 'reject') fault(409, 'A destination entry already exists')
      if (policy === 'overwrite') {
        await (await this.resolver.checked(root, path)).close()
        return { ref: target, existing }
      }
    }
    return fault(409, 'No available filename')
  }
  async commitStage(
    ref: ResourceRef,
    id: string,
    guard: Guard,
    conflict: Conflict = 'reject',
    beforePublish?: (ref: ResourceRef, identity: string) => void,
    expectedVersion?: string,
    beforeSkip?: () => void,
  ) {
    requireId(id)
    return this.inspect(
      ref,
      async (r) => {
        guard('upload', ref)
        return withHandle(await this.stageParent(r, ref, guard), async (d) =>
          withHandle(await this.resolver.private(r, 'stage'), async (stage) => {
            const staged = fdPath(stage) + '/' + id,
              meta = await lstat(staged, { bigint: true })
            safeStat(meta)
            if (!meta.isFile()) fault(409, 'Invalid upload stage')
            const target = await this.destination(r, d, ref, conflict)
            if (!target) {
              beforeSkip?.()
              await unlink(staged)
              await stage.sync()
              return null
            }
            guard('upload', target.ref)
            const output = fdPath(d) + '/' + leaf(target.ref)
            if (target.existing) {
              if (!target.existing.isFile())
                fault(409, 'Only regular files can be replaced by uploads')
              guard('modify', target.ref)
            }
            if (
              expectedVersion !== undefined &&
              (!target.existing || version(target.existing) !== expectedVersion)
            )
              fault(412, 'File changed since it was opened')
            beforePublish?.(target.ref, identity(meta))
            if (target.existing) await rename(staged, output)
            else {
              await link(staged, output)
              await d.sync()
              await unlink(staged)
            }
            await d.sync()
            await stage.sync()
            return target.ref
          }),
        )
      },
      true,
    )
  }
  recoverStage(ref: ResourceRef, id: string, expectedIdentity: string) {
    requireId(id)
    return this.inspect(
      ref,
      async (r) => {
        return withHandle(
          await this.resolver.directory(r, parent(ref).segments),
          async (d) =>
            withHandle(
              await this.resolver.private(r, 'stage'),
              async (stage) => {
                const path = fdPath(d) + '/' + leaf(ref),
                  published = await exists(path)
                if (
                  !published?.isFile() ||
                  identity(published) !== expectedIdentity ||
                  published.nlink > 2n
                )
                  return false
                const temp = fdPath(stage) + '/' + id,
                  leftover = await exists(temp)
                if (published.nlink === 2n) {
                  if (
                    !leftover?.isFile() ||
                    identity(leftover) !== expectedIdentity
                  )
                    return false
                  await unlink(temp)
                  await stage.sync()
                } else if (leftover) return false
                await d.sync()
                return true
              },
            ),
        )
      },
      true,
    )
  }

  private async inventory(
    root: Root,
    source: string,
    ref: ResourceRef,
    visit: (ref: ResourceRef, s: BigIntStats) => void,
  ) {
    const result: Array<{
      ref: ResourceRef
      relative: string[]
      s: BigIntStats
    }> = []
    const walk = async (
      path: string,
      current: ResourceRef,
      relative: string[],
    ) => {
      if (result.length >= treeLimit)
        fault(413, 'Operation exceeds the directory entry limit')
      await withHandle(await this.resolver.checked(root, path), async (h) => {
        const s = await h.stat({ bigint: true })
        visit(current, s)
        result.push({ ref: current, relative, s })
        if (s.isDirectory())
          for await (const name of names(h, false)) {
            await walk(fdPath(h) + '/' + name, child(current, name), [
              ...relative,
              name,
            ])
          }
      })
    }
    await walk(source, ref, [])
    return result
  }

  // Copy using bounded, positional reads. Verify the staged file by rereading it
  // before the destination is published or a cross-mount source can be removed.
  private async copyBytes(
    source: FileHandle,
    dest: FileHandle,
    s: BigIntStats,
    signal?: AbortSignal,
    progress?: (phase: CopyProgress['phase'], bytes: number) => void,
  ) {
    const digest = createHash('sha256'),
      check = createHash('sha256'),
      chunk = Buffer.allocUnsafe(1024 * 1024)
    const n = Number(s.size)
    for (let position = 0; position < n;) {
      if (signal?.aborted) fault(409, 'Copy cancelled before publication')
      const { bytesRead } = await source.read(
        chunk,
        0,
        Math.min(chunk.length, n - position),
        position,
      )
      if (!bytesRead) fault(409, 'Source changed during copy')
      digest.update(chunk.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        const { bytesWritten } = await dest.write(
          chunk,
          written,
          bytesRead - written,
          position + written,
        )
        if (!bytesWritten) fault(507, 'Storage could not write the copy')
        written += bytesWritten
      }
      position += bytesRead
      progress?.('copying', position)
    }
    await dest.utimes(s.atime, s.mtime)
    await dest.sync()
    for (let position = 0; position < n;) {
      if (signal?.aborted) fault(409, 'Copy cancelled before publication')
      const { bytesRead } = await dest.read(
        chunk,
        0,
        Math.min(chunk.length, n - position),
        position,
      )
      if (!bytesRead) fault(503, 'Copy verification failed')
      check.update(chunk.subarray(0, bytesRead))
      position += bytesRead
      progress?.('verifying', position)
    }
    if (version(await source.stat({ bigint: true })) !== version(s))
      fault(409, 'Source changed during copy')
    if (!digest.digest().equals(check.digest()))
      fault(503, 'Copy verification failed')
  }

  private async removePlanned(
    base: string,
    items: Array<{ relative: string[]; s: BigIntStats; ref: ResourceRef }>,
    guard?: Guard,
    retirement?: { root: Root; trashId?: string },
  ) {
    for (const item of items.slice().reverse()) {
      const path = [base, ...item.relative].join('/')
      const current = await lstat(path, { bigint: true })
      if (
        identity(current) !== identity(item.s) ||
        (!item.s.isDirectory() && version(current) !== version(item.s))
      )
        fault(409, 'Entry changed during operation')
      guard?.('delete', item.ref)
      if (item.s.isDirectory()) await rmdir(path)
      else if (retirement) {
        const { root, trashId } = retirement
        const segments = trashId
          ? [trashId, ...item.relative]
          : item.ref.segments
        await this.retirements.remove(
          root,
          path,
          current,
          trashId ? 'trash' : 'entry',
          segments.slice(0, -1),
          () => guard?.('delete', item.ref),
        )
      } else await unlink(path)
    }
  }
  // Private trees contain only the ordinary entries produced by this service.
  // Removing them uses the same no-follow checks as user-visible operations.
  private async cleanPrivate(root: Root, path: string, ref: ResourceRef) {
    if (!(await exists(path))) return
    const items = await this.inventory(root, path, ref, () => {})
    await this.removePlanned(path, items)
  }

  private async reconcile(root: Root) {
    await this.publication.reconcile(root)
    await this.retirements.reconcile(root)
    const copies = this.db
      .query<{ id: string }, [string]>(
        'SELECT id FROM fs_copy_stages WHERE mount=?',
      )
      .all(root.mount.id)
    if (copies.length) {
      await withHandle(
        await this.resolver.private(root, 'stage'),
        async (stage) => {
          for (const { id } of copies) {
            requireId(id)
            await this.cleanPrivate(root, fdPath(stage) + '/' + id, {
              mountId: root.mount.id,
              segments: [],
            })
            await stage.sync()
            this.db.query('DELETE FROM fs_copy_stages WHERE id=?').run(id)
          }
        },
      )
    }
    const moving = this.db
      .query<TrashRow, [string]>(
        "SELECT * FROM fs_trash WHERE mount=? AND state='moving'",
      )
      .all(root.mount.id)
    if (moving.length) {
      await withHandle(
        await this.resolver.private(root, 'trash'),
        async (trash) => {
          for (const row of moving) {
            requireId(row.id)
            const meta = await exists(fdPath(trash) + '/' + row.id)
            if (!meta)
              this.db.query('DELETE FROM fs_trash WHERE id=?').run(row.id)
            else if (identity(meta) === row.identity)
              this.db
                .query("UPDATE fs_trash SET state='trashed' WHERE id=?")
                .run(row.id)
            else fault(503, 'Trash recovery requires maintenance')
          }
        },
      )
    }
  }
  operate(
    op: Operation,
    src: ResourceRef,
    dest: ResourceRef | null,
    guard: Guard,
    conflict: Conflict = 'reject',
    signal?: AbortSignal,
    onProgress?: (event: CopyProgress) => void,
  ): Promise<ResourceRef | null> {
    if (signal?.aborted) fault(409, 'Operation cancelled')
    checkRef(src)
    parent(src)
    if (!['trash', 'delete', 'copy', 'move', 'rename'].includes(op))
      fault(400, 'Unknown file operation')
    if (dest) {
      checkRef(dest)
      parent(dest)
    }
    if (op === 'delete' || op === 'trash') {
      return this.inspect(
        src,
        async (r) =>
          withHandle(
            await this.resolver.directory(r, parent(src).segments),
            async (d) => {
              const path = fdPath(d) + '/' + leaf(src),
                items = await this.inventory(r, path, src, (ref) =>
                  guard('delete', ref),
                )
              if (op === 'delete') {
                await this.removePlanned(path, items, guard, { root: r })
                await d.sync()
                return null
              }
              return withHandle(
                await this.resolver.private(r, 'trash'),
                async (trash) => {
                  const id = randomUUID(),
                    target = fdPath(trash) + '/' + id
                  guard('delete', src)
                  const meta = await lstat(path, { bigint: true })
                  this.db
                    .query('INSERT INTO fs_trash VALUES(?,?,?,?,?,?)')
                    .run(
                      id,
                      src.mountId,
                      JSON.stringify(src.segments),
                      Date.now(),
                      'moving',
                      identity(meta),
                    )
                  await rename(path, target)
                  await trash.sync()
                  await d.sync()
                  this.db
                    .query("UPDATE fs_trash SET state='trashed' WHERE id=?")
                    .run(id)
                  return null
                },
              )
            },
          ),
        true,
      )
    }
    if (!dest) fault(400, 'Destination required')
    const to = dest
    if (descendant(src, to) || descendant(to, src))
      fault(409, 'Choose a separate destination')
    if (
      op === 'rename' &&
      (src.mountId !== to.mountId ||
        JSON.stringify(parent(src).segments) !==
          JSON.stringify(parent(to).segments))
    )
      fault(400, 'Rename must stay in its original directory')
    const keys = [src.mountId, to.mountId]
    return this.queues.run(keys, () =>
      this.root(src.mountId, op !== 'copy', async (sourceRoot) =>
        this.root(to.mountId, true, async (destRoot) => {
          return withHandle(
            await this.resolver.directory(sourceRoot, parent(src).segments),
            async (sourceDir) =>
              withHandle(
                await this.resolver.directory(destRoot, parent(to).segments),
                async (targetDir) => {
                  const sourcePath = fdPath(sourceDir) + '/' + leaf(src)
                  guard(op, src)
                  guard('create', parent(to))
                  guard('create', to)
                  const destination = await this.destination(
                    destRoot,
                    targetDir,
                    to,
                    conflict,
                  )
                  if (!destination) return null
                  const selected = destination.ref
                  const authorize = (ref: ResourceRef, s: BigIntStats) => {
                    if (signal?.aborted)
                      fault(409, 'Operation cancelled before publication')
                    guard(op, ref)
                    if (op === 'move') guard('delete', ref)
                    if (op === 'copy' || src.mountId !== selected.mountId)
                      guard(s.isDirectory() ? 'list' : 'read', ref)
                    const target = {
                      mountId: selected.mountId,
                      segments: [
                        ...selected.segments,
                        ...ref.segments.slice(src.segments.length),
                      ],
                    }
                    guard('create', target)
                  }
                  const items = await this.inventory(
                    sourceRoot,
                    sourcePath,
                    src,
                    authorize,
                  )
                  const first = items[0]
                  if (!first) fault(404, 'Source unavailable')
                  if (destination.existing) guard('modify', selected)
                  if (op !== 'copy' && src.mountId === selected.mountId) {
                    await this.publication.publish(
                      destRoot,
                      'entry',
                      src.segments,
                      sourceDir,
                      selected,
                      targetDir,
                      destination.existing,
                    )
                    await sourceDir.sync()
                    await targetDir.sync()
                    return selected
                  }
                  await withHandle(
                    await this.resolver.private(destRoot, 'stage'),
                    async (stage) => {
                      const copyId = randomUUID()
                      const temporary = fdPath(stage) + '/' + copyId
                      this.db
                        .query('INSERT INTO fs_copy_stages VALUES(?,?)')
                        .run(copyId, destRoot.mount.id)
                      try {
                        for (const item of items) {
                          const path = [temporary, ...item.relative].join('/')
                          authorize(item.ref, item.s)
                          if (item.s.isDirectory()) {
                            await mkdir(path, { mode: 0o750 })
                            continue
                          }
                          await withHandle(
                            await this.opened(sourceRoot, item.ref),
                            async (input) => {
                              await withHandle(
                                await open(
                                  path,
                                  C.O_RDWR |
                                    C.O_CREAT |
                                    C.O_EXCL |
                                    C.O_NOFOLLOW,
                                  0o640,
                                ),
                                async (outputHandle) => {
                                  await this.copyBytes(
                                    input,
                                    outputHandle,
                                    item.s,
                                    signal,
                                    onProgress
                                      ? (phase, bytes) =>
                                          onProgress({
                                            phase,
                                            bytes,
                                            ref: item.ref,
                                            total: Number(item.s.size),
                                          })
                                      : undefined,
                                  )
                                },
                              )
                            },
                          )
                        }
                        // Flush nested directory entries before publication. The destination must
                        // survive a crash before a move may remove the original tree.
                        for (const item of items.slice().reverse()) {
                          if (item.s.isDirectory()) {
                            const directory = [
                              temporary,
                              ...item.relative,
                            ].join('/')
                            await withHandle(
                              await this.resolver.checked(
                                destRoot,
                                directory,
                                true,
                              ),
                              async (h) => {
                                await h.utimes(item.s.atime, item.s.mtime)
                                await h.sync()
                              },
                            )
                          }
                        }
                        for (const item of items) {
                          authorize(item.ref, item.s)
                          const s = await lstat(
                            [sourcePath, ...item.relative].join('/'),
                            { bigint: true },
                          )
                          if (version(s) !== version(item.s))
                            fault(409, 'Source changed during copy')
                        }
                        if (signal?.aborted)
                          fault(409, 'Operation cancelled before publication')
                        if (destination.existing) guard('modify', selected)
                        await this.publication.publish(
                          destRoot,
                          'stage',
                          [copyId],
                          stage,
                          selected,
                          targetDir,
                          destination.existing,
                        )
                        await targetDir.sync()
                        await stage.sync()
                      } finally {
                        // Reconcile a linked copy before removing either of its two names.
                        await this.publication.reconcile(destRoot)
                        await this.cleanPrivate(destRoot, temporary, selected)
                        this.db
                          .query('DELETE FROM fs_copy_stages WHERE id=?')
                          .run(copyId)
                      }
                    },
                  )
                  if (op === 'move') {
                    try {
                      await this.removePlanned(sourcePath, items, guard)
                      await sourceDir.sync()
                    } catch {
                      fault(
                        409,
                        'Destination copied and verified. Source removal was incomplete.',
                      )
                    }
                  }
                  return selected
                },
              ),
          )
        }),
      ),
    )
  }
  async bulkRename(
    entries: readonly { ref: ResourceRef; name: string }[],
    guard: Guard,
    conflict: Conflict = 'reject',
    signal?: AbortSignal,
  ) {
    if (!entries.length || entries.length > 256)
      fault(400, 'Choose between 1 and 256 entries')
    // Resolve every requested name and reject ambiguous batches before moving anything.
    const sources = new Set<string>(),
      destinations = new Set<string>()
    const batch = entries.map(({ ref, name }) => {
      checkRef(ref)
      const destination = child(parent(ref), name)
      const key = JSON.stringify([ref.mountId, ref.segments]),
        dest = JSON.stringify([destination.mountId, destination.segments])
      if (sources.has(key) || destinations.has(dest))
        fault(400, 'Duplicate entry or destination in batch')
      sources.add(key)
      destinations.add(dest)
      return { ref, name, destination, key, dest }
    })
    if (batch.some((item) => item.key !== item.dest && sources.has(item.dest)))
      fault(409, 'A destination is another selected entry')
    const results: Array<{
      ref: ResourceRef
      name: string
      ok: boolean
      result?: ResourceRef | null
      error?: string
      status?: number
    }> = []
    for (const { ref, name, destination, key, dest } of batch) {
      try {
        if (signal?.aborted) fault(409, 'Operation cancelled')
        guard('rename', ref)
        const result =
          key === dest
            ? ref
            : await this.operate(
                'rename',
                ref,
                destination,
                guard,
                conflict,
                signal,
              )
        results.push({ ref, name, ok: true, result })
      } catch (e) {
        const error = storageError(e)
        results.push({
          ref,
          name,
          ok: false,
          error: error.message,
          status: error.status,
        })
      }
    }
    return results
  }
  private row(id: string): TrashRow {
    requireId(id)
    return (
      this.db
        .query<TrashRow, [string]>('SELECT * FROM fs_trash WHERE id=?')
        .get(id) ?? fault(404, 'Trash entry unavailable')
    )
  }
  private original(row: TrashRow): ResourceRef {
    const stored: unknown = JSON.parse(row.path)
    if (
      !Array.isArray(stored) ||
      !stored.every((s): s is string => typeof s === 'string')
    )
      fault(500, 'Invalid stored reference')
    const ref: ResourceRef = { mountId: row.mount, segments: stored }
    checkRef(ref)
    parent(ref)
    return ref
  }
  trash(guard: Guard): TrashItem[] {
    const rows = this.db
      .query<TrashRow, []>(
        'SELECT * FROM fs_trash ORDER BY deleted DESC LIMIT 20001',
      )
      .all()
    if (rows.length > treeLimit) fault(413, 'Trash listing limit exceeded')
    return rows.flatMap((row) => {
      const ref = this.original(row)
      return this.isEnabled(row.mount) &&
        permit(guard, 'list', ref) &&
        permit(guard, 'delete', ref)
        ? [{ id: row.id, ref, deletedAt: row.deleted }]
        : []
    })
  }
  restore(id: string, guard: Guard, conflict: Conflict = 'reject') {
    const row = this.row(id),
      ref = this.original(row)
    return this.inspect(
      ref,
      async (root) => {
        guard('delete', ref)
        guard('create', parent(ref))
        return withHandle(
          await this.resolver.private(root, 'trash'),
          async (trash) =>
            withHandle(
              await this.resolver.directory(root, parent(ref).segments),
              async (d) => {
                const source = fdPath(trash) + '/' + id
                const s = await exists(source)
                if (!s || identity(s) !== row.identity)
                  fault(409, 'Trash entry unavailable')
                const chosen = await this.destination(root, d, ref, conflict)
                if (!chosen) return null
                await this.inventory(root, source, ref, (original) => {
                  guard('delete', original)
                  guard('create', {
                    mountId: ref.mountId,
                    segments: [
                      ...chosen.ref.segments,
                      ...original.segments.slice(ref.segments.length),
                    ],
                  })
                })
                if (chosen.existing) guard('modify', chosen.ref)
                await this.publication.publish(
                  root,
                  'trash',
                  [id],
                  trash,
                  chosen.ref,
                  d,
                  chosen.existing,
                )
                await d.sync()
                await trash.sync()
                this.db.query('DELETE FROM fs_trash WHERE id=?').run(id)
                return chosen.ref
              },
            ),
        )
      },
      true,
    )
  }
  async purgeTrash(id: string, guard: Guard) {
    const row = this.row(id),
      ref = this.original(row)
    await this.inspect(
      ref,
      async (root) => {
        guard('delete', ref)
        await withHandle(
          await this.resolver.private(root, 'trash'),
          async (trash) => {
            const source = fdPath(trash) + '/' + id,
              s = await exists(source)
            if (s) {
              if (identity(s) !== row.identity)
                fault(409, 'Trash entry changed')
              const items = await this.inventory(root, source, ref, (r) =>
                guard('delete', r),
              )
              await this.removePlanned(source, items, guard, {
                root,
                trashId: id,
              })
              await trash.sync()
            }
            this.db.query('DELETE FROM fs_trash WHERE id=?').run(id)
          },
        )
      },
      true,
    )
  }
  trashRetention(mountId: string): number | null {
    if (!this.mounts.some((m) => m.id === mountId))
      fault(404, 'Unknown storage')
    return (
      this.db
        .query<{ duration: number }, [string]>(
          'SELECT duration FROM fs_retention WHERE mount=?',
        )
        .get(mountId)?.duration ?? null
    )
  }
  setTrashRetention(mountId: string, durationMs: number | null) {
    if (!this.mounts.some((m) => m.id === mountId))
      fault(404, 'Unknown storage')
    if (durationMs === null) {
      this.db.query('DELETE FROM fs_retention WHERE mount=?').run(mountId)
      return
    }
    if (!Number.isSafeInteger(durationMs) || durationMs < 0)
      fault(400, 'Invalid trash retention')
    this.db
      .query(
        'INSERT INTO fs_retention VALUES(?,?) ON CONFLICT(mount) DO UPDATE SET duration=excluded.duration',
      )
      .run(mountId, durationMs)
  }
  collectTrashTask(retentionMs: number) {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0)
      return Effect.fail(new AppError(400, 'Invalid trash retention'))
    return Effect.flatMap(Clock.currentTimeMillis, (now) =>
      attempt(async () => {
        const rows = this.db
          .query<{ id: string }, [number, number]>(
            `SELECT t.id FROM fs_trash t
        LEFT JOIN fs_retention r ON r.mount=t.mount LEFT JOIN fs_mount_state m ON m.id=t.mount
        WHERE COALESCE(m.enabled,1)=1 AND t.deleted<=?-COALESCE(r.duration,?) ORDER BY t.deleted LIMIT 64`,
          )
          .all(now, retentionMs)
        for (const { id } of rows) await this.purgeTrash(id, () => {})
      }, storageError),
    )
  }
  collectTrash(retentionMs: number) {
    return runTask(this.collectTrashTask(retentionMs))
  }
}
export class FileStorage extends Context.Service<FileStorage, Filesystem>()(
  'fileserver/FileStorage',
) {}
export const fileStorageLayer = (
  mounts: Mount[],
  db: Database,
  privateLocations?: AppConfig['privateLocations'],
) =>
  Layer.effect(
    FileStorage,
    Effect.try({
      try: () => new Filesystem(mounts, db, privateLocations),
      catch: storageError,
    }),
  )
