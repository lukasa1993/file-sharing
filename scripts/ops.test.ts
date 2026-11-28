import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup, initialize, restore } from './ops'

describe('operator state', () => {
  test('restores committed WAL metadata and private configuration into a fresh directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fileserver-restore-'))
    const source = join(root, 'source')
    const snapshot = join(root, 'backup')
    const target = join(root, 'restored')
    let live: Database | undefined
    try {
      await initialize(source, 'owner')
      const key = await readFile(join(source, 'config/session.key'), 'utf8')
      const mountConfig = JSON.parse(
        await readFile(join(source, 'config/mounts.json'), 'utf8'),
      )
      expect(mountConfig.mounts[0].sentinel).toBe(
        (
          await readFile(join(source, 'storage/.fileserver-root'), 'utf8')
        ).trim(),
      )
      expect(
        (await stat(join(source, 'config/bootstrap.json'))).mode & 0o777,
      ).toBe(0o600)
      await expect(initialize(source, 'second')).rejects.toThrow()
      live = new Database(join(source, 'data/fileserver.sqlite'), {
        create: true,
      })
      live.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES('snapshot')",
      )
      await writeFile(join(source, 'storage/private.txt'), 'file bytes')
      await backup(source, snapshot)
      live.exec("INSERT INTO sample VALUES('later')")
      await expect(backup(source, snapshot)).rejects.toThrow()
      await restore(snapshot, target)
      const recovered = new Database(join(target, 'data/fileserver.sqlite'), {
        readonly: true,
      })
      try {
        expect(recovered.query('SELECT value FROM sample').values()).toEqual([
          ['snapshot'],
        ])
      } finally {
        recovered.close()
      }
      expect(await readFile(join(target, 'config/session.key'), 'utf8')).toBe(
        key,
      )
      await expect(access(join(snapshot, 'private.txt'))).rejects.toThrow()
      await expect(access(join(snapshot, 'bootstrap.json'))).rejects.toThrow()
      await expect(restore(snapshot, target)).rejects.toThrow()
      await writeFile(join(snapshot, 'session.key'), 'corrupt')
      const other = join(root, 'rejected')
      await expect(restore(snapshot, other)).rejects.toThrow(
        'checksum mismatch',
      )
      await expect(access(other)).rejects.toThrow()
    } finally {
      live?.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
