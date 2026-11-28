import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { opendir, type FileHandle } from 'node:fs/promises'
import type { Mount } from '../app/contracts.ts'
import {
  Resolver,
  fdPath,
  identity,
  pinMatchesVersion,
  privateDir,
  version,
  type Root,
} from '../app/filesystem/resolver.ts'
import type { Share } from '../app/shares/store.ts'

type Item = {
  mount: string
  path: string
  kind: 'file' | 'directory'
  protection: string
  digest: string
  version: string
  identity: string
  tracked: string
}

/** Visit pinned handles and hash only ordinary single-link files. Include private staging, trash and markers. */
async function inventory(mounts: Mount[], consume: (item: Item) => void) {
  const resolver = new Resolver(mounts)
  const chunk = Buffer.alloc(256 * 1024)
  async function visit(
    root: Root,
    path: string[],
    handle: FileHandle,
  ): Promise<void> {
    if (path.length > 132)
      throw new Error(
        'Portable storage depth exceeds the supported path limit.',
      )
    const before = await handle.stat({ bigint: true })
    const kind = before.isDirectory() ? 'directory' : 'file'
    let digest = ''
    if (kind === 'file') {
      const sha = createHash('sha256')
      let offset = 0
      while (offset < Number(before.size)) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, Number(before.size) - offset),
          offset,
        )
        if (!bytesRead) throw new Error('Storage changed during verification.')
        sha.update(chunk.subarray(0, bytesRead))
        offset += bytesRead
      }
      digest = sha.digest('hex')
    } else {
      const children = await opendir(fdPath(handle), { encoding: 'latin1' })
      for await (const child of children) {
        const bytes = Buffer.from(child.name, 'latin1'),
          name = bytes.toString('utf8')
        if (!Buffer.from(name).equals(bytes))
          throw new Error('Portable backups require UTF-8 filenames.')
        const next = await resolver.checked(root, fdPath(handle) + '/' + name)
        try {
          await visit(root, [...path, name], next)
        } finally {
          await next.close()
        }
      }
    }
    if (version(await handle.stat({ bigint: true })) !== version(before))
      throw new Error('Storage changed during verification.')
    consume({
      mount: root.mount.id,
      path: JSON.stringify(path),
      kind,
      protection: [before.mode, before.uid, before.gid].join(':'),
      digest,
      version: version(before),
      identity: identity(before),
      tracked: identity(before) + ':' + before.birthtimeNs,
    })
  }
  for (const mount of mounts) {
    const root = await resolver.openRoot(mount.id)
    try {
      await visit(root, [], root.h)
    } finally {
      await root.h.close()
    }
  }
}

function requireSettled(db: Database) {
  const pending = db
    .query(
      `SELECT
    (SELECT count(*) FROM fs_publications) + (SELECT count(*) FROM fs_copy_stages)
    + (SELECT count(*) FROM fs_trash WHERE state <> 'trashed')
    + (SELECT count(*) FROM fs_tracked_files WHERE state NOT IN ('live','deleted'))
    + (SELECT count(*) FROM transfer_uploads WHERE state IN ('allocating','publishing','skipping'))`,
    )
    .values()[0]?.[0]
  if (pending !== 0)
    throw new Error(
      'Unfinished filesystem work requires normal recovery and a clean shutdown before a portable backup.',
    )
}

export async function recordStorage(db: Database, mounts: Mount[]) {
  requireSettled(db)
  db.exec(`CREATE TABLE operator_storage_inventory (
    mount TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, protection TEXT NOT NULL,
    digest TEXT NOT NULL, version TEXT NOT NULL, identity TEXT NOT NULL, tracked TEXT NOT NULL,
    PRIMARY KEY(mount,path), UNIQUE(mount,identity)
  )`)
  const insert = db.query(
    'INSERT INTO operator_storage_inventory VALUES(?,?,?,?,?,?,?,?)',
  )
  await inventory(mounts, (e) => {
    insert.run(
      e.mount,
      e.path,
      e.kind,
      e.protection,
      e.digest,
      e.version,
      e.identity,
      e.tracked,
    )
  })
  // Every receiving upload must have at least its acknowledged prefix in the matched private copy.
  const stage = db.query<{ version: string; kind: string }, [string, string]>(
    'SELECT version,kind FROM operator_storage_inventory WHERE mount=? AND path=?',
  )
  for (const row of db
    .query<{ id: string; mount: string; offset: number }, []>(
      "SELECT id,mount,offset FROM transfer_uploads WHERE state='receiving'",
    )
    .iterate()) {
    const file = stage.get(
      row.mount,
      JSON.stringify([privateDir, 'stage', row.id]),
    )
    if (
      !file ||
      file.kind !== 'file' ||
      Number(file.version.split(':')[2]) < row.offset
    )
      throw new Error(
        'A pending upload is missing acknowledged bytes. Recover the original service before backup.',
      )
  }
}
export async function verifyAndRebind(db: Database, mounts: Mount[]) {
  requireSettled(db)
  db.exec(`CREATE TEMP TABLE restored_objects(mount TEXT NOT NULL,path TEXT NOT NULL,version TEXT NOT NULL,
    identity TEXT NOT NULL,tracked TEXT NOT NULL,PRIMARY KEY(mount,path))`)
  const evidence = db.query<Item, [string, string]>(
    'SELECT * FROM operator_storage_inventory WHERE mount=? AND path=?',
  )
  const matched = db.query('INSERT INTO restored_objects VALUES(?,?,?,?,?)')
  await inventory(mounts, (e) => {
    const old = evidence.get(e.mount, e.path)
    if (
      !old ||
      old.kind !== e.kind ||
      old.protection !== e.protection ||
      old.digest !== e.digest
    )
      throw new Error(
        'Storage does not match the portable snapshot. Check file bytes, permissions, owners and directory entries.',
      )
    matched.run(e.mount, e.path, e.version, e.identity, e.tracked)
  })
  if (
    db
      .query(
        'SELECT 1 FROM operator_storage_inventory e LEFT JOIN restored_objects r USING(mount,path) WHERE r.path IS NULL LIMIT 1',
      )
      .get()
  )
    throw new Error('Storage is missing an entry from the portable snapshot.')
  const pair = db.query<
    { kind: string; source: string; restored: string },
    [string, string]
  >(
    `SELECT e.kind,e.version AS source,r.version AS restored FROM operator_storage_inventory e JOIN restored_objects r USING(mount,path) WHERE e.mount=? AND e.path=?`,
  )
  for (const row of db
    .query<{ id: string; data: string }, []>(
      'SELECT id,data FROM shares WHERE broken=0',
    )
    .iterate()) {
    const share: Share = JSON.parse(row.data)
    let available = true
    for (const target of share.targets) {
      const versions = pair.get(
        target.ref.mountId,
        JSON.stringify(target.ref.segments),
      )
      if (
        !versions ||
        versions.kind !== target.kind ||
        (!share.latestAtPath &&
          !pinMatchesVersion(
            target.version,
            versions.source,
            target.kind === 'directory',
          ))
      ) {
        available = false
        break
      }
      target.version = versions.restored
    }
    if (available)
      db.query('UPDATE shares SET data=? WHERE id=?').run(
        JSON.stringify(share),
        row.id,
      )
    else db.query('UPDATE shares SET broken=1 WHERE id=?').run(row.id)
  }
  for (const row of db
    .query<{ id: string; mount: string; identity: string }, []>(
      'SELECT id,mount,identity FROM fs_trash',
    )
    .iterate()) {
    const path = JSON.stringify([privateDir, 'trash', row.id])
    const old = evidence.get(row.mount, path)
    if (!old || old.identity !== row.identity)
      throw new Error('Trash metadata does not match its original storage.')
    db.query(
      'UPDATE fs_trash SET identity=(SELECT identity FROM restored_objects WHERE mount=? AND path=?) WHERE id=?',
    ).run(row.mount, path, row.id)
  }
  // Keep retired and externally missing byte charges distinct from copied live file identities.
  db.exec(`CREATE TEMP TABLE restored_tracking AS SELECT f.mount, f.identity AS previous,
    CASE WHEN f.state='live' AND r.tracked IS NOT NULL THEN r.tracked
    WHEN f.identity LIKE 'snapshot:%' THEN f.identity ELSE 'snapshot:'||f.identity END AS current
    FROM fs_tracked_files f LEFT JOIN operator_storage_inventory e ON e.mount=f.mount AND e.tracked=f.identity
    LEFT JOIN restored_objects r ON r.mount=e.mount AND r.path=e.path;
    CREATE UNIQUE INDEX restored_tracking_previous ON restored_tracking(mount,previous);
    UPDATE transfer_storage_files AS f SET identity=(SELECT current FROM restored_tracking t WHERE t.mount=f.mount AND t.previous=f.identity);
    UPDATE fs_tracked_files SET identity='pending:'||identity;
    UPDATE fs_tracked_files AS f SET identity=(SELECT current FROM restored_tracking t WHERE t.mount=f.mount AND t.previous=substr(f.identity,9));
    DROP TABLE operator_storage_inventory`)
}
