import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Filesystem } from '../app/filesystem/index.ts'
import { Transfers } from '../app/transfers/index.ts'

const owner = { actor: 'owner', guard: () => {} }
const base = 'http://localhost/_/uploads'
const tus = { 'Tus-Resumable': '1.0.0' }
const patch = (service: Transfers, id: string, offset: number, body: string) =>
  service.upload(
    new Request(base + '/' + id, {
      method: 'PATCH',
      headers: {
        ...tus,
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(offset),
      },
      body,
    }),
    owner,
    id,
  )

for (const phase of [
  'during-write',
  'after-sync',
  'before-publish',
  'after-publish',
]) {
  test(
    'a new process recovers upload state after SIGKILL ' + phase,
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'fileserver-wal-crash-'))
      const path = join(root, 'files')
      const database = join(root, 'state.sqlite')
      const mounts = [
        {
          id: 'files',
          label: 'Files',
          path,
          sentinel: 'crash-test',
          readOnly: false,
        },
      ]
      const openService = () => {
        const db = new Database(database)
        db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
        return { db, service: new Transfers(db, new Filesystem(mounts, db)) }
      }
      try {
        await mkdir(path)
        await writeFile(join(path, '.fileserver-root'), 'crash-test')
        const first = openService()
        let id: string
        try {
          const created = await first.service.upload(
            new Request(base, {
              method: 'POST',
              headers: {
                ...tus,
                'Upload-Length': '6',
                'Upload-Metadata': 'filename dGVzdA==,mount ZmlsZXM=',
              },
            }),
            owner,
          )
          expect(created.status).toBe(201)
          const last = created.headers.get('location')?.split('/').at(-1)
          if (!last) throw new Error('Missing upload session.')
          id = last
          expect((await patch(first.service, id, 0, 'abc')).status).toBe(204)
        } finally {
          await first.service.shutdown()
          first.db.close()
        }
        const child = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, 'transfers-crash-worker.ts'),
            root,
            database,
            id,
            phase,
          ],
          { stdout: 'ignore', stderr: 'pipe', timeout: 20000 },
        )
        await child.exited
        const stderr = await new Response(child.stderr).text()
        expect(stderr).toBe('')
        expect(child.signalCode).toBe('SIGKILL')
        const restarted = openService()
        try {
          await restarted.service.cleanup()
          const status = await restarted.service.upload(
            new Request(base + '/' + id, { method: 'HEAD', headers: tus }),
            owner,
            id,
          )
          const completed = phase === 'after-publish'
          expect(status.status).toBe(200)
          expect(status.headers.get('upload-offset')).toBe(
            completed ? '6' : '3',
          )
          expect(status.headers.get('upload-state')).toBe(
            completed ? 'completed' : 'receiving',
          )
          if (!completed) {
            await expect(readFile(join(path, 'test'))).rejects.toThrow()
            expect((await patch(restarted.service, id, 3, 'def')).status).toBe(
              204,
            )
          }
          expect(await readFile(join(path, 'test'), 'utf8')).toBe('abcdef')
          expect((await patch(restarted.service, id, 3, 'def')).status).toBe(
            409,
          )
        } finally {
          await restarted.service.shutdown()
          restarted.db.close()
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    30000,
  )
}
