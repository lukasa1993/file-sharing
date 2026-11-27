import { Database } from 'bun:sqlite'
import { withStateLease } from '../app/state-lease.ts'
import { loadConfig } from '../app/config.ts'
import { recordStorage, verifyAndRebind } from './storage-inventory.ts'
import { array, enum_, object, parse, string } from 'remix/data-schema'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'

const dbName = 'fileserver.sqlite'
const configNames = ['mounts.json', 'session.key'] as const
const snapshotFiles = [dbName, ...configNames] as const

async function newDirectory(target: string, populate: () => Promise<void>) {
  await mkdir(target, { mode: 0o700 })
  try {
    await writeFile(join(target, '.gitignore'), '*\n', {
      flag: 'wx',
      mode: 0o600,
    })
    await populate()
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
}

export async function initialize(
  stateDirectory: string,
  username: string,
  options: {
    container?: boolean
    mountId?: string
    password?: string
  } = {},
) {
  if (!username.trim() || username.length > 128)
    throw new Error('Provide a valid administrator name.')
  const state = resolve(stateDirectory)
  const config = join(state, 'config')
  const storage = join(state, 'storage')
  const sentinel = randomUUID()
  const mountId = options.mountId ?? 'files'
  const password = options.password ?? randomBytes(32).toString('base64url')
  await newDirectory(state, async () => {
    for (const dir of [config, storage, join(state, 'data')])
      await mkdir(dir, { mode: 0o700 })
    const mount = {
      id: mountId,
      label: 'Files',
      path: options.container ? '/srv/files' : storage,
      readOnly: false,
      sentinel,
    }
    const files: [string, string][] = [
      [join(storage, '.fileserver-root'), sentinel],
      [
        join(config, 'mounts.json'),
        JSON.stringify({ mounts: [mount] }, null, 2),
      ],
      [join(config, 'bootstrap.json'), JSON.stringify({ username, password })],
      [join(config, 'session.key'), randomBytes(48).toString('base64url')],
    ]
    for (const [path, value] of files)
      await writeFile(path, value + '\n', { flag: 'wx', mode: 0o600 })
  })
}

async function regularFile(path: string) {
  const stat = await lstat(path)
  if (!stat.isFile()) throw new Error(`Expected a regular file at ${path}.`)
}

async function readJson(path: string): Promise<unknown> {
  await regularFile(path)
  if ((await lstat(path)).size > 65536)
    throw new Error('Configuration or manifest exceeds 64 KiB.')
  return JSON.parse(await readFile(path, 'utf8'))
}

async function copyPrivate(source: string, target: string) {
  await regularFile(source)
  await copyFile(source, target)
  await chmod(target, 0o600)
}

async function digest(path: string) {
  await regularFile(path)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function checkDatabase(path: string) {
  const db = new Database(path, { readonly: true })
  try {
    const result = db.query('PRAGMA quick_check').values()
    if (result.length !== 1 || result[0]?.[0] !== 'ok')
      throw new Error('SQLite integrity check failed.')
  } finally {
    db.close()
  }
}

function contains(parent: string, child: string) {
  const path = relative(parent, child)
  return (
    path === '' ||
    (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path))
  )
}

async function outsideStorage(
  configFile: string,
  destination: string,
  other: string[] = [],
) {
  const dest = join(
    await realpath(dirname(resolve(destination))),
    basename(resolve(destination)),
  )
  const config = parse(
    object({ mounts: array(object({ path: string() })) }),
    await readJson(configFile),
  )
  if (
    [...other, ...config.mounts.map((m) => m.path)].some((path) =>
      contains(path, dest),
    )
  ) {
    throw new Error(
      'Choose a destination outside application state and served roots.',
    )
  }
}

async function storageInventory(
  state: string,
  snapshot: string,
  record: boolean,
) {
  const config = loadConfig({
    PUBLIC_ORIGIN: 'http://127.0.0.1',
    DATA_DIR: join(state, 'data'),
    CONFIG_FILE: join(state, 'config', 'mounts.json'),
    SESSION_SECRET_FILE: join(state, 'config', 'session.key'),
  })
  const db = new Database(snapshot)
  try {
    db.exec('BEGIN IMMEDIATE')
    if (record) await recordStorage(db, config.mounts)
    else await verifyAndRebind(db, config.mounts)
    db.exec('COMMIT')
    if (!record) db.exec('VACUUM')
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

export async function backup(
  stateDirectory: string,
  destination: string,
  portable = false,
) {
  await outsideStorage(
    join(stateDirectory, 'config', 'mounts.json'),
    destination,
    [await realpath(stateDirectory)],
  )
  const dbPath = join(stateDirectory, 'data', dbName)
  await regularFile(dbPath)
  const snapshotState = () =>
    newDirectory(destination, async () => {
      const snapshot = join(destination, dbName)
      const lock = portable ? new Database(dbPath) : undefined
      try {
        lock?.exec('PRAGMA busy_timeout=15000; BEGIN IMMEDIATE')
        const db = new Database(dbPath, { readonly: true })
        try {
          db.exec('PRAGMA busy_timeout=5000')
          db.query('VACUUM INTO ?').run(resolve(snapshot))
        } finally {
          db.close()
        }
        await chmod(snapshot, 0o600)
        for (const name of configNames) {
          await copyPrivate(
            join(stateDirectory, 'config', name),
            join(destination, name),
          )
        }
        if (portable) await storageInventory(stateDirectory, snapshot, true)
        checkDatabase(snapshot)
      } finally {
        lock?.close()
      }
      const sha256: Record<string, string> = {}
      for (const name of snapshotFiles)
        sha256[name] = await digest(join(destination, name))
      const manifest = {
        format: portable ? 2 : 1,
        createdAt: new Date().toISOString(),
        sha256,
      }
      await writeFile(
        join(destination, 'manifest.json'),
        JSON.stringify(manifest, null, 2) + '\n',
        { mode: 0o600, flag: 'wx' },
      )
    })
  if (portable)
    await withStateLease(join(stateDirectory, 'data'), snapshotState)
  else await snapshotState()
}

export async function restore(snapshot: string, destination: string) {
  const manifest = parse(
    object({
      format: enum_([1, 2]),
      sha256: object({
        [dbName]: string(),
        'mounts.json': string(),
        'session.key': string(),
      }),
    }),
    await readJson(join(snapshot, 'manifest.json')),
  )
  const mountFile = join(snapshot, 'mounts.json')
  if ((await digest(mountFile)) !== manifest.sha256['mounts.json'])
    throw new Error('Snapshot checksum mismatch for mounts.json.')
  await outsideStorage(mountFile, destination, [await realpath(snapshot)])
  await newDirectory(destination, async () => {
    const data = join(destination, 'data')
    const config = join(destination, 'config')
    await mkdir(data, { mode: 0o700 })
    await mkdir(config, { mode: 0o700 })
    await withStateLease(data, async () => {
      for (const name of snapshotFiles) {
        const target = join(name === dbName ? data : config, name)
        await copyPrivate(join(snapshot, name), target)
        if ((await digest(target)) !== manifest.sha256[name])
          throw new Error(`Snapshot checksum mismatch for ${name}.`)
      }
      checkDatabase(join(data, dbName))
      if (manifest.format === 2) {
        await storageInventory(destination, join(data, dbName), false)
        checkDatabase(join(data, dbName))
      }
    })
  })
}

if (import.meta.main) {
  const [command, source, destination, flag, ...extra] = Bun.argv.slice(2)
  try {
    if (
      !source ||
      !destination ||
      extra.length ||
      (flag &&
        !(command === 'init' && flag === '--container') &&
        !(command === 'backup' && flag === '--portable'))
    ) {
      throw new Error(
        'Usage: ops init STATE USER [--container] | backup STATE NEW_SNAPSHOT [--portable] | restore SNAPSHOT NEW_STATE',
      )
    }
    if (command === 'init') {
      await initialize(source, destination, {
        container: flag === '--container',
      })
      console.log(
        'Initialized private state. The initial credentials are in config/bootstrap.json inside the new state directory.',
      )
    } else if (command === 'backup') {
      await backup(source, destination, flag === '--portable')
      console.log(
        flag === '--portable'
          ? 'Portable metadata snapshot and storage inventory verified. Keep the matching ordinary storage copy with this snapshot.'
          : 'SQLite metadata, mount configuration and signing key backed up.',
      )
    } else if (command === 'restore') {
      await restore(source, destination)
      console.log(
        'Metadata restored to new state. Verify the configured storage roots before starting the service.',
      )
    } else {
      throw new Error('Unknown operation. Choose init, backup, or restore.')
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Operation failed.')
    process.exitCode = 1
  }
}
