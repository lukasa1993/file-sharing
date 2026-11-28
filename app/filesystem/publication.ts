import type { Database } from 'bun:sqlite'
import type { BigIntStats } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { ResourceRef } from '../contracts.ts'
import {
  Resolver,
  type Root,
  checkRef,
  code,
  fault,
  fdPath,
  identity,
  leaf,
  parent,
  safeStat,
} from './resolver.ts'

type Location = 'entry' | 'stage' | 'trash'
type Row = {
  id: string
  mount: string
  area: Location
  source: string
  destination: string
  identity: string
  reservation: string | null
}
async function maybeStat(path: string) {
  try {
    return await lstat(path, { bigint: true })
  } catch (e) {
    if (code(e) === 'ENOENT') return null
    throw e
  }
}
function decode(mountId: string, encoded: string): ResourceRef {
  try {
    const segments: unknown = JSON.parse(encoded)
    if (
      Array.isArray(segments) &&
      segments.length &&
      segments.every((part): part is string => typeof part === 'string')
    ) {
      const ref = { mountId, segments }
      checkRef(ref)
      return ref
    }
  } catch {
    // Damaged journal data is a storage failure regardless of its syntax.
    return fault(503, 'Invalid recovery record')
  }
  return fault(503, 'Invalid recovery record')
}
const privateId =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export class PublicationJournal {
  constructor(
    private db: Database,
    private resolver: Resolver,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS fs_publications(
       id TEXT PRIMARY KEY, mount TEXT NOT NULL, area TEXT NOT NULL, source TEXT NOT NULL,
       destination TEXT NOT NULL, identity TEXT NOT NULL, reservation TEXT);
       CREATE INDEX IF NOT EXISTS fs_publication_mount ON fs_publications(mount);`)
  }
  async publish(
    root: Root,
    area: Location,
    sourceSegments: readonly string[],
    sourceDir: FileHandle,
    to: ResourceRef,
    destinationDir: FileHandle,
    existing: BigIntStats | null,
  ) {
    const sourceName =
      sourceSegments.at(-1) ?? fault(500, 'Missing publication source')
    const source = fdPath(sourceDir) + '/' + sourceName,
      output = fdPath(destinationDir) + '/' + leaf(to)
    const src = await lstat(source, { bigint: true })
    safeStat(src)
    if (existing && (src.isDirectory() || existing.isDirectory()))
      fault(409, 'Replacing an existing directory is unsupported')
    const id = randomUUID()
    this.db
      .query('INSERT INTO fs_publications VALUES(?,?,?,?,?,?,NULL)')
      .run(
        id,
        root.mount.id,
        area,
        JSON.stringify(sourceSegments),
        JSON.stringify(to.segments),
        identity(src),
      )
    if (existing) {
      const current = await lstat(output, { bigint: true })
      if (
        identity(existing) !== identity(current) ||
        existing.ctimeNs !== current.ctimeNs
      )
        fault(409, 'Destination changed')
      await rename(source, output)
    } else if (src.isFile()) {
      await link(source, output)
      // An interruption here leaves the journal and two names for the same inode.
      // The destination directory must be durable before removing the source.
      await destinationDir.sync()
      await unlink(source)
    } else {
      // An exclusive mkdir reserves the name. rename only replaces an empty
      // directory. Never clean up a reservation that an external writer filled.
      await mkdir(output, { mode: 0o700 })
      const reservation = await lstat(output, { bigint: true })
      this.db
        .query('UPDATE fs_publications SET reservation=? WHERE id=?')
        .run(identity(reservation), id)
      await rename(source, output)
    }
    await destinationDir.sync()
    await sourceDir.sync()
    this.finish(id, area, sourceName, true)
  }
  private finish(id: string, area: Location, name: string, published: boolean) {
    this.db.transaction(() => {
      if (published && area === 'trash')
        this.db.query('DELETE FROM fs_trash WHERE id=?').run(name)
      this.db.query('DELETE FROM fs_publications WHERE id=?').run(id)
    })()
  }
  // Called under the mount mutation semaphore, before serving a request. A
  // committed copy whose source still exists is recognized by inode, not name.
  async reconcile(root: Root) {
    const pending = this.db
      .query<Row, [string]>(
        'SELECT * FROM fs_publications WHERE mount=? LIMIT 65',
      )
      .all(root.mount.id)
    if (pending.length > 64) fault(503, 'Mount recovery requires maintenance')
    for (const row of pending) {
      const src = decode(row.mount, row.source),
        dest = decode(row.mount, row.destination)
      const privateArea = row.area === 'stage' || row.area === 'trash'
      if (row.area !== 'entry' && !privateArea)
        fault(503, 'Invalid journal area')
      if (
        privateArea &&
        (src.segments.length !== 1 || !privateId.test(leaf(src)))
      )
        fault(503, 'Invalid internal publication source')
      const destDir = await this.resolver.directory(root, parent(dest).segments)
      try {
        const srcDir =
          row.area === 'entry'
            ? await this.resolver.directory(root, parent(src).segments)
            : await this.resolver.private(root, row.area)
        try {
          const srcPath = fdPath(srcDir) + '/' + leaf(src),
            finalPath = fdPath(destDir) + '/' + leaf(dest)
          const current = await maybeStat(finalPath),
            original = await maybeStat(srcPath)
          const published =
            current !== null && identity(current) === row.identity
          if (published && original && identity(original) === row.identity) {
            if (!current.isFile() || !original.isFile() || current.nlink !== 2n)
              fault(503, 'File publication needs maintenance')
            await destDir.sync()
            await unlink(srcPath)
            await srcDir.sync()
          } else if (
            current &&
            row.reservation &&
            identity(current) === row.reservation
          ) {
            await rmdir(finalPath).catch((e) => {
              if (code(e) !== 'ENOTEMPTY' && code(e) !== 'ENOENT') throw e
            })
            await destDir.sync()
          }
          this.finish(row.id, row.area, leaf(src), published)
        } finally {
          await srcDir.close()
        }
      } finally {
        await destDir.close()
      }
    }
  }
}
