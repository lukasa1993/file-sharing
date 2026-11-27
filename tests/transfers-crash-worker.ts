import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { Filesystem } from '../app/filesystem/index.ts'
import { Transfers } from '../app/transfers/index.ts'

const [root, database, id, phase] = process.argv.slice(2)
if (!root || !database || !id || !phase)
  throw new Error('Missing upload crash fixture.')
const killWorker = () => {
  process.kill(process.pid, 'SIGKILL')
  throw new Error('SIGKILL must stop this worker.')
}

class CrashFilesystem extends Filesystem {
  override async openStage(mount: string, id: string) {
    const handle = await super.openStage(mount, id)
    if (phase === 'after-sync') {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        await sync()
        killWorker()
      }
    }
    return handle
  }

  override async commitStage(...args: Parameters<Filesystem['commitStage']>) {
    const [ref, id, guard, conflict, recordIntent, expected, beforeSkip] = args
    const result = await super.commitStage(
      ref,
      id,
      guard,
      conflict,
      (chosen, identity) => {
        recordIntent?.(chosen, identity)
        if (phase === 'before-publish') killWorker()
      },
      expected,
      beforeSkip,
    )
    if (phase === 'after-publish') killWorker()
    return result
  }
}

const db = new Database(database)
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
const fs = new CrashFilesystem(
  [
    {
      id: 'files',
      label: 'Files',
      path: join(root, 'files'),
      sentinel: 'crash-test',
      readOnly: false,
    },
  ],
  db,
)
const service = new Transfers(db, fs)
let body: BodyInit = 'def'
if (phase === 'during-write') {
  let first = true
  body = new ReadableStream(
    {
      pull(controller) {
        if (first) {
          first = false
          controller.enqueue(Buffer.from('d'))
        } else killWorker()
      },
    },
    { highWaterMark: 0 },
  )
}
const response = await service.upload(
  new Request('http://localhost/_/uploads/' + id, {
    method: 'PATCH',
    headers: {
      'Tus-Resumable': '1.0.0',
      'Content-Type': 'application/offset+octet-stream',
      'Upload-Offset': '3',
    },
    body,
  }),
  { actor: 'owner', guard: () => {} },
  id,
)
throw new Error('The worker missed its crash phase: ' + response.status)
