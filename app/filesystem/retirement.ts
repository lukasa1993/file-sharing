import type { Database } from 'bun:sqlite'
import type { BigIntStats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { link, lstat, unlink, type FileHandle } from 'node:fs/promises'
import { AppError } from '../contracts.ts'
import {
  Resolver,
  type Root,
  checkRef,
  code,
  fault,
  fdPath,
  identity,
} from './resolver.ts'

type Area = 'entry' | 'trash'
type Retirement = {
  mount: string
  identity: string
  state: 'moving' | 'retired'
  stage: string
  area: Area
  parent: string
}
function objectIdentity(s: BigIntStats) {
  return identity(s) + ':' + s.birthtimeNs
}
const stageId =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

// A charge registers an object by dev, inode and positive birth time. On
// permanent removal, a private hard link witnesses the object's last name.
// If the original unlink never happened, recovery removes just the witness.
export class RetirementJournal {
  constructor(
    private db: Database,
    private resolver: Resolver,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS fs_tracked_files(
      mount TEXT NOT NULL, identity TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'live',
      stage TEXT, area TEXT, parent TEXT, PRIMARY KEY(mount,identity));
      CREATE INDEX IF NOT EXISTS fs_retirements ON fs_tracked_files(mount,state);`)
  }
  private finish(row: Retirement, state: 'live' | 'deleted') {
    this.db
      .query(
        'UPDATE fs_tracked_files SET state=?, stage=NULL, area=NULL, parent=NULL WHERE mount=? AND identity=?',
      )
      .run(state, row.mount, row.identity)
  }
  private async syncSourceParent(root: Root, row: Retirement) {
    const segments: unknown = JSON.parse(row.parent)
    if (
      !Array.isArray(segments) ||
      !segments.every((name): name is string => typeof name === 'string')
    )
      fault(503, 'Invalid retirement directory')
    checkRef({ mountId: root.mount.id, segments })
    let current =
      row.area === 'trash'
        ? await this.resolver.private(root, 'trash')
        : await this.resolver.directory(root, [])
    try {
      for (const name of segments) {
        // An external writer may have removed or replaced an emptied directory
        // while the service was stopped. Sync its closest surviving parent.
        let next: FileHandle
        try {
          next = await this.resolver.checked(
            root,
            fdPath(current) + '/' + name,
            true,
          )
        } catch (error) {
          if (
            code(error) === 'ENOENT' ||
            (error instanceof AppError && error.status === 404)
          )
            break
          throw error
        }
        await current.close()
        current = next
      }
      await current.sync()
    } finally {
      await current.close()
    }
  }

  private async settle(root: Root, stage: FileHandle, row: Retirement) {
    if (
      !stageId.test(row.stage) ||
      (row.area !== 'entry' && row.area !== 'trash')
    )
      fault(503, 'Invalid retirement record')
    const path = fdPath(stage) + '/' + row.stage
    const s = await lstat(path, { bigint: true }).catch((error: unknown) => {
      if (code(error) === 'ENOENT') return null
      throw error
    })
    if (s && (!s.isFile() || objectIdentity(s) !== row.identity))
      fault(503, 'Retirement witness changed')
    if (row.state === 'moving') {
      if (!s || s.nlink !== 1n) {
        if (s) {
          await unlink(path)
          await stage.sync()
        }
        this.finish(row, 'live')
        return
      }
      await this.syncSourceParent(root, row)
      await stage.sync()
      this.db
        .query(
          "UPDATE fs_tracked_files SET state='retired' WHERE mount=? AND identity=?",
        )
        .run(row.mount, row.identity)
    } else if (s && s.nlink !== 1n)
      fault(503, 'Retired file acquired an unexpected link')
    if (s) await unlink(path)
    await stage.sync()
    this.finish(row, 'deleted')
  }

  async remove(
    root: Root,
    path: string,
    s: BigIntStats,
    area: Area,
    parent: string[],
    authorize: () => void,
  ) {
    const id = objectIdentity(s)
    if (
      s.birthtimeNs <= 0n ||
      !this.db
        .query(
          "SELECT 1 FROM fs_tracked_files WHERE mount=? AND identity=? AND state='live'",
        )
        .get(root.mount.id, id)
    ) {
      await unlink(path)
      return
    }
    const stage = await this.resolver.private(root, 'stage')
    try {
      const row: Retirement = {
        mount: root.mount.id,
        identity: id,
        state: 'moving',
        stage: randomUUID(),
        area,
        parent: JSON.stringify(parent),
      }
      this.db
        .query(
          "UPDATE fs_tracked_files SET state='moving',stage=?,area=?,parent=? WHERE mount=? AND identity=?",
        )
        .run(row.stage, row.area, row.parent, row.mount, row.identity)
      const witness = fdPath(stage) + '/' + row.stage
      await link(path, witness)
      await stage.sync()
      const linked = await lstat(witness, { bigint: true })
      const source = await lstat(path, { bigint: true })
      if (
        objectIdentity(linked) !== id ||
        objectIdentity(source) !== id ||
        linked.nlink !== 2n ||
        linked.size !== s.size ||
        linked.mtimeNs !== s.mtimeNs
      ) {
        await unlink(witness)
        await stage.sync()
        this.finish(row, 'live')
        fault(409, 'File changed during deletion')
      }
      authorize()
      await unlink(path)
      await this.settle(root, stage, row)
    } finally {
      await stage.close()
    }
  }
  async reconcile(root: Root) {
    const rows = this.db
      .query<Retirement, [string]>(
        "SELECT * FROM fs_tracked_files WHERE mount=? AND state IN ('moving','retired') LIMIT 65",
      )
      .all(root.mount.id)
    if (!rows.length) return
    if (rows.length > 64) fault(503, 'Retirement queue requires maintenance')
    const stage = await this.resolver.private(root, 'stage')
    try {
      for (const row of rows) await this.settle(root, stage, row)
    } finally {
      await stage.close()
    }
  }
}
