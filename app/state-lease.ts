import { Database } from 'bun:sqlite'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs'
import { join } from 'node:path'

/** Hold a process-owned SQLite lock without locking the live metadata database or retaining its WAL. */
export async function withStateLease<A>(
  directory: string,
  run: () => Promise<A>,
): Promise<A> {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, 'operator-lock.sqlite')
  for (const suffix of ['-journal', '-wal', '-shm']) {
    if (lstatSync(file + suffix, { throwIfNoEntry: false }))
      throw new Error(
        'Unexpected companion file for the service maintenance lock.',
      )
  }
  const fd = openSync(
    file,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  )
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
      throw new Error(
        'The service maintenance lock must be a private regular file.',
      )
  } finally {
    closeSync(fd)
  }
  const gate = new Database(file)
  try {
    try {
      gate.exec(
        'PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE',
      )
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
      )
        throw new Error(
          'The service or a portable storage operation is active. Stop it before continuing.',
        )
      throw error
    }
    return await run()
  } finally {
    gate.close()
  }
}
