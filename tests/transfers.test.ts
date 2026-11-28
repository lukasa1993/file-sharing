import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Clock, Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTar } from 'remix/tar-parser'
import { ContentDisposition } from 'remix/headers'
import { AppError, type Guard, type ResourceRef } from '../app/contracts.ts'
import { Filesystem } from '../app/filesystem/index.ts'
import { listenHttp } from '../app/transport.ts'
import { Transfers, type UploadAccess } from '../app/transfers/index.ts'

const ok: Guard = () => {}
const owner: UploadAccess = { actor: 'fixture-owner', guard: ok }
const base = 'http://127.0.0.1'
const ref = (...segments: string[]): ResourceRef => ({
  mountId: 'files',
  segments,
})
const tus = { 'Tus-Resumable': '1.0.0' }
let root: string
let db: Database
let fs: Filesystem
let transfers: Transfers

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fileserver-transfers-'))
  await writeFile(join(root, '.fileserver-root'), 'fixture\n')
  db = new Database(':memory:')
  fs = new Filesystem(
    [
      {
        id: 'files',
        label: 'Files',
        path: root,
        sentinel: 'fixture',
        readOnly: false,
      },
    ],
    db,
  )
  transfers = new Transfers(db, fs)
})
afterEach(async () => {
  await transfers.shutdown()
  db.close()
  await rm(root, { recursive: true, force: true })
})
const request = (headers: HeadersInit = {}, method = 'GET') =>
  new Request(base + '/share', { method, headers })
const create = (
  name: string,
  size: number,
  extra: Record<string, string> = {},
  actor = owner,
) => {
  const meta = Object.entries({ filename: name, mount: 'files', ...extra })
    .map(([k, v]) => k + ' ' + Buffer.from(v).toString('base64'))
    .join(',')
  return transfers.upload(
    new Request(base + '/_/uploads', {
      method: 'POST',
      headers: {
        ...tus,
        'Upload-Length': String(size),
        'Upload-Metadata': meta,
      },
    }),
    actor,
  )
}
const uploadId = (created: Response) => {
  expect(created.status).toBe(201)
  return new URL(created.headers.get('location')!, base).pathname
    .split('/')
    .pop()!
}
const patch = (id: string, offset: number, data: BodyInit, actor = owner) =>
  transfers.upload(
    new Request(base + '/_/uploads/' + id, {
      method: 'PATCH',
      headers: {
        ...tus,
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(offset),
      },
      body: data,
    }),
    actor,
    id,
  )
const head = (id: string, actor = owner) =>
  transfers.upload(
    new Request(base + '/_/uploads/' + id, { method: 'HEAD', headers: tus }),
    actor,
    id,
  )

describe('native download representation', () => {
  test('downloads from the pinned handle with the original Unicode filename and bytes', async () => {
    const name = 'Summer à la mer.txt'
    await writeFile(join(root, name), 'old bytes')
    const response = await transfers.download(request(), ref(name), ok)
    await rename(join(root, name), join(root, 'archived'))
    await writeFile(join(root, name), 'new bytes')
    expect(await response.text()).toBe('old bytes')
    expect(response.status).toBe(200)
    expect(
      ContentDisposition.from(response.headers.get('content-disposition'))
        .preferredFilename,
    ).toBe(name)
    expect(response.headers.get('etag')).toBe(
      '"' + createHash('sha256').update('old bytes').digest('hex') + '"',
    )
    expect(response.headers.get('content-length')).toBe('9')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
  })
  test('evaluates preconditions, range boundaries, stale resume and HEAD with no lease side effects', async () => {
    await writeFile(join(root, 'data'), 'abcdef')
    let starts = 0
    let bytes = 0
    const options = {
      onStart: () => {
        starts++
      },
      onBytes: (n: number) => {
        bytes += n
      },
    }
    const read = (headers: HeadersInit, method = 'GET') =>
      transfers.download(request(headers, method), ref('data'), ok, options)
    const meta = await read({ Range: 'bytes=1-2' }, 'HEAD')
    const tag = meta.headers.get('etag')!
    expect(meta.status).toBe(200)
    expect(meta.body).toBeNull()
    expect(meta.headers.get('content-length')).toBe('6')
    expect((await read({ 'If-None-Match': tag })).status).toBe(304)
    expect((await read({ 'If-Match': '"outdated"' })).status).toBe(412)
    const invalid = await read({ Range: 'bytes=8-' })
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('content-range')).toBe('bytes */6')
    expect(starts).toBe(0)
    const ranged = await read({ Range: 'bytes=-2', 'If-Range': tag })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 4-5/6')
    expect(await ranged.text()).toBe('ef')
    const remainder = await read({ Range: 'bytes=1-', 'If-Range': tag })
    expect(await remainder.text()).toBe('bcdef')
    const stale = await read({ Range: 'bytes=2-', 'If-Range': '"different"' })
    expect(stale.status).toBe(200)
    expect(await stale.text()).toBe('abcdef')
    const multi = await read({ Range: 'bytes=0-1,4-5' })
    expect(multi.status).toBe(200)
    expect(await multi.text()).toBe('abcdef')
    expect(starts).toBe(4)
    expect(bytes).toBe(19)
    expect(transfers.active()).toHaveLength(0)
  })
  test('requires strong If-Range validators when a mutable file can change inside one second', async () => {
    await writeFile(join(root, 'mutable'), 'version-one')
    const meta = await transfers.download(
      request({}, 'HEAD'),
      ref('mutable'),
      ok,
    )
    const date = meta.headers.get('last-modified')
    const tag = meta.headers.get('etag')
    if (!date || !tag) throw new Error('Missing response validators.')
    for (const supplied of [
      date,
      'W/' + tag,
      '',
      'Sat, 01 Jan 2000 00:00:00 GMT',
    ]) {
      const response = await transfers.download(
        request({ Range: 'bytes=-3', 'If-Range': supplied }),
        ref('mutable'),
        ok,
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('version-one')
    }
    const part = await transfers.download(
      request({ Range: 'bytes=-3', 'If-Range': tag }),
      ref('mutable'),
      ok,
    )
    expect(part.status).toBe(206)
    expect(await part.text()).toBe('one')
  })
  test('releases a pending response on caller cancellation and checks current access before 304', async () => {
    await writeFile(join(root, 'file'), '1234')
    transfers = new Transfers(db, fs, { maxConcurrent: 1 })
    const first = await transfers.download(request(), ref('file'), ok)
    const tag = first.headers.get('etag')!
    await expect(
      transfers.download(request(), ref('file'), ok),
    ).rejects.toThrow('Too many active')
    await first.body!.cancel()
    expect(transfers.active()).toHaveLength(0)
    await expect(
      transfers.download(request({ 'If-None-Match': tag }), ref('file'), () => {
        throw new AppError(403, 'Access denied')
      }),
    ).rejects.toThrow('Access denied')
    const second = await transfers.download(request(), ref('file'), ok)
    const job = transfers.active()[0]!
    expect(transfers.cancel(job.id)).toBe(true)
    await expect(second.text()).rejects.toThrow()
    await transfers.shutdown()
    expect(transfers.active()).toHaveLength(0)
  })
  test('cold hashing pauses the configured transport timeout after authorization and restores it before headers', async () => {
    await writeFile(join(root, 'clocked'), 'file')
    const transitions: boolean[] = []
    const tracked = () => {
      const req = request({}, 'HEAD')
      transfers.setPreparationTimeout(req, (value) => transitions.push(value))
      return req
    }
    await expect(
      transfers.download(tracked(), ref('clocked'), () => {
        throw new AppError(403, 'Permission denied.')
      }),
    ).rejects.toThrow()
    expect(transitions).toEqual([])
    expect(
      (await transfers.download(tracked(), ref('clocked'), ok)).status,
    ).toBe(200)
    expect(transitions).toEqual([true, false])
    expect(
      (await transfers.download(tracked(), ref('clocked'), ok)).status,
    ).toBe(200)
    expect(transitions).toEqual([true, false])
  })

  test('low-bandwidth downloads deliver a small first chunk and release on cancellation', async () => {
    await writeFile(join(root, 'limited'), Buffer.alloc(256 * 1024, 7))
    const res = await transfers.download(request(), ref('limited'), ok, {
      bytesPerSecond: 8192,
    })
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(first.value?.byteLength).toBe(1024)
    expect(transfers.cancel(transfers.active()[0]!.id)).toBe(true)
    await expect(reader.read()).rejects.toThrow()
    await transfers.shutdown()
    expect(transfers.active()).toHaveLength(0)
  })

  test('a real client disconnect and an administrator stop release throttled streams before the network deadline', async () => {
    await writeFile(join(root, 'slow'), Buffer.alloc(256 * 1024, 7))
    const server = await listenHttp({ hostname: '127.0.0.1', port: 0 }, (req) =>
      transfers.download(req, ref('slow'), ok, { bytesPerSecond: 8192 }),
    )
    try {
      for (const mode of ['client', 'admin']) {
        const deadline = AbortSignal.timeout(5000)
        const client = new AbortController()
        const response = await fetch(server.url, {
          signal: AbortSignal.any([deadline, client.signal]),
        })
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Missing throttled body.')
        const first = await reader.read()
        expect(first.value?.byteLength).toBeGreaterThan(0)
        const job = transfers.active()[0]
        if (!job) throw new Error('Missing active download.')
        if (mode === 'client') client.abort()
        else expect(transfers.cancel(job.id)).toBe(true)
        const readRemaining = async () => {
          while (!(await reader.read()).done) {}
        }
        await expect(readRemaining()).rejects.toThrow()
        while (transfers.active().length && !deadline.aborted)
          await Bun.sleep(5)
        expect(deadline.aborted).toBe(false)
        expect(transfers.active()).toHaveLength(0)
        reader.releaseLock()
      }
    } finally {
      await server.stop(true)
    }
  })
  test('zero-byte and multiple concurrent native range requests over actual HTTP', async () => {
    await writeFile(join(root, 'file'), 'abcdef')
    await writeFile(join(root, 'empty'), '')
    const server = await listenHttp({ hostname: '127.0.0.1', port: 0 }, (req) =>
      transfers.download(req, ref(new URL(req.url).pathname.slice(1)), ok),
    )
    try {
      const [first, last, empty] = await Promise.all([
        fetch(new URL('/file', server.url), {
          headers: { Range: 'bytes=0-2' },
        }),
        fetch(new URL('/file', server.url), { headers: { Range: 'bytes=3-' } }),
        fetch(new URL('/empty', server.url)),
      ])
      expect([first.status, last.status, empty.status]).toEqual([206, 206, 200])
      expect(
        [first, last, empty].map((r) => r.headers.get('content-length')),
      ).toEqual(['3', '3', '0'])
      expect([
        await first.text(),
        await last.text(),
        await empty.text(),
      ]).toEqual(['abc', 'def', ''])
    } finally {
      await server.stop(true)
    }
  })
})

describe('resumable uploads and publication', () => {
  test('TestClock expires a partial upload and cleanup releases its quota and staging file', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        transfers = new Transfers(
          db,
          fs,
          { uploadTtlMs: 5000 },
          yield* Clock.Clock,
        )
        const limited = { ...owner, quota: 4 }
        const id = uploadId(
          yield* Effect.promise(() => create('abandoned.bin', 4, {}, limited)),
        )
        yield* TestClock.adjust(3000)
        expect(
          (yield* Effect.promise(() => patch(id, 0, 'hi', limited))).status,
        ).toBe(204)
        yield* TestClock.adjust(4999)
        yield* Effect.promise(() => transfers.cleanup())
        expect((yield* Effect.promise(() => head(id, limited))).status).toBe(
          200,
        )
        expect(
          (yield* Effect.promise(() => create('next.bin', 4, {}, limited)))
            .status,
        ).toBe(413)
        yield* TestClock.adjust(1)
        expect((yield* Effect.promise(() => head(id, limited))).status).toBe(
          410,
        )
        yield* Effect.promise(() => transfers.cleanup())
        yield* Effect.promise(async () => {
          await expect(fs.openStage('files', id)).rejects.toThrow()
        })
        expect(
          (yield* Effect.promise(() => create('next.bin', 4, {}, limited)))
            .status,
        ).toBe(201)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  })

  test('termination cancels an active authorized writer, then releases staging and the reservation', async () => {
    const limited = { ...owner, quota: 8 }
    const id = uploadId(await create('terminate', 8, {}, limited))
    expect((await patch(id, 0, 'bytes', limited)).status).toBe(204)
    const pulled = Promise.withResolvers<void>()
    const pending = patch(
      id,
      5,
      new ReadableStream(
        {
          pull() {
            pulled.resolve()
          },
        },
        { highWaterMark: 0 },
      ),
      limited,
    )
    await pulled.promise
    const terminate = (actor: UploadAccess) =>
      transfers.upload(
        new Request(base, { method: 'DELETE', headers: tus }),
        actor,
        id,
      )
    expect((await terminate({ ...limited, actor: 'other' })).status).toBe(404)
    expect((await head(id, limited)).headers.get('upload-offset')).toBe('5')
    expect((await patch(id, 5, 'abc', limited)).status).toBe(409)
    const [removed, interrupted] = await Promise.all([
      terminate(limited),
      pending,
    ])
    expect([removed.status, interrupted.status]).toEqual([204, 409])
    expect((await head(id, limited)).status).toBe(404)
    await expect(fs.openStage('files', id)).rejects.toThrow()
    expect((await create('next', 8, {}, limited)).status).toBe(201)
  })
  test('validates negotiation, required metadata, lengths and authorship before creating a session', async () => {
    const send = (
      method: string,
      headers: Record<string, string>,
      body?: string,
    ) =>
      transfers.upload(
        new Request(base, { method, headers, ...(body ? { body } : {}) }),
        owner,
      )
    const caps = await send('OPTIONS', {})
    expect(caps.status).toBe(204)
    expect(caps.headers.get('tus-extension')).toBe(
      'creation,termination,expiration',
    )
    expect((await send('POST', {})).status).toBe(412)
    const meta = 'mount ZmlsZXM=,filename Zg=='
    const post = (value: string, length = '1', body?: string) =>
      send(
        'POST',
        { ...tus, 'Upload-Length': length, 'Upload-Metadata': value },
        body,
      )
    for (const value of [
      '',
      'filename Zg==',
      'mount ZmlsZXM=',
      'mount ZmlsZXM=,filename',
      meta +
        ',path ' +
        Buffer.from(Array(129).fill('a').join('/')).toString('base64'),
      'mount ZmlsZXM=,filename /w==',
      meta + ',filename Zg==',
      meta + ',x z',
      meta + ',conflict ZmFsc2U=',
      meta + ',sha256 YWJj',
      'filename Zg==,mount ZmlsZXM=,x ' + 'Y'.repeat(8200),
    ])
      expect((await post(value)).status).toBe(400)
    for (const value of ['-1', '1.5', '9007199254740992'])
      expect((await post(meta, value)).status).toBe(400)
    expect((await post(meta, '1', 'x')).status).toBe(400)
    expect(
      db
        .query<{ n: number }, []>('SELECT count(*) n FROM transfer_uploads')
        .get()?.n,
    ).toBe(0)
  })
  test('chunk framing and method errors preserve the last confirmed offset', async () => {
    const id = uploadId(await create('framed', 5))
    const send = (
      method: string,
      headers: Record<string, string>,
      body?: string,
      item = id,
    ) =>
      transfers.upload(
        new Request(base + '/_/uploads/' + item, {
          method,
          headers: { ...tus, ...headers },
          ...(body === undefined ? {} : { body }),
        }),
        owner,
        item,
      )
    const chunk = {
      'Content-Type': 'application/offset+octet-stream',
      'Upload-Offset': '0',
    }
    expect((await send('GET', {})).status).toBe(405)
    expect((await send('HEAD', {}, undefined, 'unknown')).status).toBe(404)
    expect(
      (await send('PATCH', { ...chunk, 'Content-Type': 'text/plain' }, 'abc'))
        .status,
    ).toBe(415)
    expect(
      (await send('PATCH', { ...chunk, 'Content-Length': '10' }, 'abc')).status,
    ).toBe(413)
    expect(
      (await send('PATCH', { ...chunk, 'Content-Length': '4' }, 'abc')).status,
    ).toBe(400)
    expect(
      (await send('PATCH', { ...chunk, 'Content-Length': '2' })).status,
    ).toBe(400)
    expect(
      (await send('PATCH', { ...chunk, 'Content-Length': '0' })).status,
    ).toBe(204)
    expect((await head(id)).headers.get('Upload-Offset')).toBe('0')
    expect((await patch(id, 0, 'abcde')).status).toBe(204)
    const finished = await send('DELETE', {})
    expect(finished.status).toBe(409)
    expect(finished.headers.get('Content-Type')).toStartWith('text/plain')
    expect(await readFile(join(root, 'framed'), 'utf8')).toBe('abcde')
  })
  test('a missing or shortened stage fails a PATCH locally and extra unacknowledged bytes are replaced', async () => {
    for (const kind of ['missing', 'short', 'extra']) {
      const id = uploadId(await create(kind, 5))
      expect((await patch(id, 0, 'abc')).status).toBe(204)
      if (kind === 'missing') await fs.discardStage('files', id)
      else {
        const handle = await fs.openStage('files', id)
        try {
          await handle.truncate(kind === 'short' ? 2 : 12)
        } finally {
          await handle.close()
        }
      }
      const response = await patch(id, 3, 'de')
      if (kind === 'extra') {
        expect(response.status).toBe(204)
        expect(await readFile(join(root, kind), 'utf8')).toBe('abcde')
      } else {
        expect(response.status).toBe(409)
        expect((await head(id)).headers.get('Upload-State')).toBe('failed')
        await expect(stat(join(root, kind))).rejects.toThrow()
      }
    }
  })
  test('startup reconciles an interrupted skip without touching existing bytes', async () => {
    await writeFile(join(root, 'original'), 'retained')
    const id = uploadId(await create('original', 3, { conflict: 'skip' }))
    db.query("UPDATE transfer_uploads SET state='skipping' WHERE id=?").run(id)
    await transfers.cleanup()
    const acknowledged = await head(id)
    expect(acknowledged.headers.get('upload-state')).toBe('skipped')
    expect(acknowledged.headers.get('upload-offset')).toBe('3')
    await expect(fs.openStage('files', id)).rejects.toThrow()
    expect(await readFile(join(root, 'original'), 'utf8')).toBe('retained')
  })
  test('credits verified permanent removal while retaining storage charges in trash and after unrelated replacement', async () => {
    const limited = { ...owner, quota: 3 }
    const upload = async (name: string) => {
      const id = uploadId(await create(name, 3, {}, limited))
      expect((await patch(id, 0, 'abc', limited)).status).toBe(204)
    }
    await upload('first')
    expect((await create('second', 3, {}, limited)).status).toBe(413)
    await fs.operate('rename', ref('first'), ref('moved'), ok)
    await fs.operate('trash', ref('moved'), null, ok)
    expect((await create('second', 3, {}, limited)).status).toBe(413)
    const [trashed] = fs.trash(ok)
    if (!trashed) throw new Error('Missing trash fixture.')
    await fs.purgeTrash(trashed.id, ok)
    transfers = new Transfers(db, fs)
    await upload('second')
    await fs.operate('delete', ref('second'), null, ok)
    await upload('third')
    await rename(join(root, 'third'), join(root, 'external-rename'))
    await writeFile(join(root, 'third'), 'unrelated')
    await fs.operate('delete', ref('third'), null, ok)
    expect((await create('fourth', 3, {}, limited)).status).toBe(413)
    expect(await readFile(join(root, 'external-rename'), 'utf8')).toBe('abc')
  })
  test('revalidates a changed account quota and checksum at final publication', async () => {
    let quota = 4
    const limited = { ...owner, getQuota: () => quota }
    const sha256 = createHash('sha256').update('test').digest('hex')
    const id = uploadId(await create('account-file', 4, { sha256 }, limited))
    const updates: boolean[] = []
    const final = (value: string) => {
      const req = new Request(base, {
        method: 'PATCH',
        headers: {
          ...tus,
          'Content-Type': 'application/offset+octet-stream',
          'Upload-Offset': '0',
        },
        body: value,
      })
      transfers.setPreparationTimeout(req, (enabled) => updates.push(enabled))
      return transfers.upload(req, limited, id)
    }
    quota = 1
    expect((await final('test')).status).toBe(413)
    expect((await head(id, limited)).headers.get('upload-offset')).toBe('0')
    quota = 4
    expect((await final('fail')).status).toBe(422)
    expect((await final('test')).status).toBe(204)
    expect(updates).toEqual([true, false, true, false, true, false])
  })
  test('an acknowledged stage shortened on disk must be restarted and can be terminated', async () => {
    const id = uploadId(await create('short', 6))
    expect((await patch(id, 0, 'abc')).status).toBe(204)
    const stage = await fs.openStage('files', id)
    try {
      await stage.truncate(1)
    } finally {
      await stage.close()
    }
    transfers = new Transfers(db, fs)
    await transfers.cleanup()
    const failed = await head(id)
    expect(failed.status).toBe(409)
    expect(failed.headers.get('upload-state')).toBe('failed')
    expect((await patch(id, 3, 'def')).status).toBe(409)
    expect(
      (
        await transfers.upload(
          new Request(base, { method: 'DELETE', headers: tus }),
          owner,
          id,
        )
      ).status,
    ).toBe(204)
    await expect(readFile(join(root, 'short'))).rejects.toThrow()
  })
  test('persists offsets, recovers an unacknowledged tail, and publishes exact bytes once', async () => {
    const sha256 = createHash('sha256').update('abcdef').digest('hex')
    const id = uploadId(
      await create('résumé.txt', 6, { path: 'incoming', sha256 }),
    )
    expect((await head(id)).headers.get('upload-offset')).toBe('0')
    expect((await patch(id, 0, 'abc')).status).toBe(204)
    expect((await patch(id, 0, 'abc')).status).toBe(409)
    const partial = await fs.openStage('files', id)
    try {
      await partial.write(Buffer.from('xy'), 0, 2, 3)
      await partial.sync()
    } finally {
      await partial.close()
    }
    transfers = new Transfers(db, fs)
    await transfers.cleanup()
    expect((await head(id)).headers.get('upload-offset')).toBe('3')
    await expect(stat(join(root, 'incoming', 'résumé.txt'))).rejects.toThrow()
    expect((await patch(id, 3, 'def')).headers.get('upload-state')).toBe(
      'completed',
    )
    expect(await readFile(join(root, 'incoming', 'résumé.txt'), 'utf8')).toBe(
      'abcdef',
    )
    expect((await patch(id, 3, 'def')).status).toBe(409)
  })
  test('rolls back overlong streamed bytes and refuses invalid checksum without damaging destination', async () => {
    transfers = new Transfers(db, fs, { maxChunkBytes: 3 })
    await writeFile(join(root, 'target'), 'original')
    const id = uploadId(
      await create('target', 3, {
        conflict: 'overwrite',
        sha256: '0'.repeat(64),
      }),
    )
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1]))
        c.enqueue(new Uint8Array([2, 3, 4]))
        c.close()
      },
    })
    expect((await patch(id, 0, body)).status).toBe(413)
    expect((await head(id)).headers.get('upload-offset')).toBe('0')
    expect((await patch(id, 0, 'abc')).status).toBe(422)
    expect((await head(id)).headers.get('upload-offset')).toBe('0')
    expect(await readFile(join(root, 'target'), 'utf8')).toBe('original')
    const wrong = { ...owner, actor: 'other' }
    expect((await head(id, wrong)).status).toBe(404)
    expect(
      (
        await transfers.upload(
          new Request(base, { method: 'DELETE', headers: tus }),
          owner,
          id,
        )
      ).status,
    ).toBe(204)
    expect((await head(id)).status).toBe(404)
  })
  test('publishes zero bytes at creation and handles explicit reject, rename and skip collisions', async () => {
    const first = await create('entry', 0)
    expect(first.headers.get('upload-state')).toBe('completed')
    expect(await readFile(join(root, 'entry'), 'utf8')).toBe('')
    const rejected = uploadId(await create('entry', 1))
    expect((await patch(rejected, 0, 'x')).status).toBe(409)
    const skipped = uploadId(await create('entry', 1, { conflict: 'skip' }))
    expect((await patch(skipped, 0, 'x')).headers.get('upload-state')).toBe(
      'skipped',
    )
    const renamed = uploadId(await create('entry', 1, { conflict: 'rename' }))
    expect((await patch(renamed, 0, 'y')).status).toBe(204)
    expect(await readFile(join(root, 'entry (2)'), 'utf8')).toBe('y')
  })
  test('counts reservations across recipients, rechecks revocation, and conceals upload-only collisions', async () => {
    await mkdir(join(root, 'inbox'))
    await writeFile(join(root, 'inbox', 'brief.txt'), 'existing')
    let allowed = true
    const guest: UploadAccess = {
      base: ref('inbox'),
      actor: 'guest-a',
      scope: 'share:fixture',
      cap: 8,
      guard(action) {
        if (!allowed || !['create', 'upload'].includes(action))
          throw new AppError(403, 'Not allowed')
      },
      location: '/_/uploads?share=inbox',
    }
    const created = await create(
      'brief.txt',
      5,
      { conflict: 'overwrite' },
      guest,
    )
    expect(created.headers.get('location')).toContain('?share=inbox')
    const id = uploadId(created)
    expect(
      (await create('more', 4, {}, { ...guest, actor: 'guest-b' })).status,
    ).toBe(413)
    const reduced = await patch(id, 0, 'hello', { ...guest, cap: 3 })
    expect(reduced.status).toBe(413)
    expect((await head(id, guest)).headers.get('upload-offset')).toBe('0')
    allowed = false
    expect((await patch(id, 0, 'hello', guest)).status).toBe(403)
    allowed = true
    const saved = await patch(id, 0, 'hello', guest)
    expect(saved.status).toBe(204)
    expect(await saved.text()).toBe('')
    expect(saved.headers.get('location')).toBeNull()
    expect(await readFile(join(root, 'inbox', 'brief.txt'), 'utf8')).toBe(
      'existing',
    )
    expect(await readFile(join(root, 'inbox', 'brief (2).txt'), 'utf8')).toBe(
      'hello',
    )
  })
  test('reconciles a published file after interruption between filesystem publication and DB acknowledgement', async () => {
    const id = uploadId(await create('complete', 5))
    const stage = await fs.openStage('files', id)
    try {
      await stage.writeFile('hello')
      await stage.sync()
    } finally {
      await stage.close()
    }
    await fs.commitStage(
      ref('complete'),
      id,
      ok,
      'reject',
      (target, identity) => {
        db.query(
          "UPDATE transfer_uploads SET state='publishing',final_ref=?,final_identity=? WHERE id=?",
        ).run(JSON.stringify(target), identity, id)
      },
    )
    await transfers.cleanup()
    expect((await head(id)).headers.get('upload-state')).toBe('completed')
    expect((await head(id)).headers.get('upload-offset')).toBe('5')
    expect(await readFile(join(root, 'complete'), 'utf8')).toBe('hello')
  })
  test('cancels a stream in flight and leaves its previous committed offset resumable', async () => {
    const id = uploadId(await create('cancel', 6))
    expect((await patch(id, 0, 'abc')).status).toBe(204)
    const pulled = Promise.withResolvers<void>()
    const body = new ReadableStream(
      {
        pull() {
          pulled.resolve()
        },
      },
      { highWaterMark: 0 },
    )
    const pending = patch(id, 3, body)
    await pulled.promise
    expect(transfers.cancel(transfers.active()[0]!.id)).toBe(true)
    expect((await pending).status).toBe(409)
    expect((await head(id)).headers.get('upload-offset')).toBe('3')
    expect((await patch(id, 3, 'def')).status).toBe(204)
  })
})

describe('archive and previews', () => {
  test('streams a selection as TAR with confined relative names, empty entries and Unicode', async () => {
    await mkdir(join(root, 'é'))
    await writeFile(join(root, 'é', 'note.txt'), 'inside')
    await writeFile(join(root, 'empty'), '')
    await writeFile(join(root, 'unselected'), 'private')
    const response = await transfers.archive(
      request(),
      [ref('é'), ref('empty')],
      ok,
    )
    expect(response.headers.get('accept-ranges')).toBe('none')
    const entries: Record<string, string> = {}
    await parseTar(response.body!, async (entry) => {
      entries[entry.name] = await entry.text()
    })
    expect(entries).toEqual({ é: '', 'é/note.txt': 'inside', empty: '' })
  })
  test('exports a streamed gzip TAR with the actual file contents', async () => {
    await writeFile(join(root, 'demo.txt'), 'shared')
    const response = await transfers.archive(
      new Request(base + '/share?format=tar.gz'),
      [ref('demo.txt')],
      ok,
    )
    expect(response.headers.get('content-type')).toBe('application/gzip')
    expect(
      ContentDisposition.from(response.headers.get('content-disposition'))
        .preferredFilename,
    ).toBe('shared-files.tar.gz')
    const archive = await new Response(
      response.body!.pipeThrough(new DecompressionStream('gzip')),
    ).bytes()
    const content: string[] = []
    await parseTar(archive, async (entry) => {
      content.push(await entry.text())
    })
    expect(content).toEqual(['shared'])
  })

  test('renders only supported TAR directory metadata, and rejects empty selections and unsupported export formats', async () => {
    await mkdir(join(root, 'notes'))
    await writeFile(join(root, 'notes', 'plain.txt'), 'not in listing')
    await expect(transfers.archive(request(), [], ok)).rejects.toThrow('Select')
    await expect(
      transfers.archive(new Request(base + '/?format=zip'), [ref('notes')], ok),
    ).rejects.toThrow('Supported')
    const archive = await transfers.archive(request(), [ref('notes')], ok)
    await writeFile(join(root, 'notes.tar'), await archive.bytes())
    const listing = await transfers.preview(request(), ref('notes.tar'), ok)
    expect(listing.headers.get('content-type')).toContain('text/plain')
    expect(await listing.text()).toBe('notes/\nnotes/plain.txt  14 bytes')
    await writeFile(join(root, 'bad.tar'), 'plain data')
    const fallback = await transfers.preview(request(), ref('bad.tar'), ok)
    expect(fallback.headers.get('content-disposition')).toStartWith(
      'attachment',
    )
    expect(await fallback.text()).toBe('plain data')
  })
  test('preserves byte ranges for recognized media signatures and makes malformed text download-only', async () => {
    const media = [
      ['sound.wav', 'RIFF....WAVE', 'audio/wav'],
      ['song.flac', 'fLaC', 'audio/flac'],
      ['sound.ogg', 'OggS\0', 'audio/ogg'],
      ['video.ogv', 'OggS\0', 'video/ogg'],
      ['sound.mp3', 'ID3', 'audio/mpeg'],
      ['audio.m4a', '....ftypM4A ', 'audio/mp4'],
      ['film.mp4', '....ftypisom', 'video/mp4'],
      [
        'film.webm',
        String.fromCharCode(26, 69, 223, 163) + 'webm',
        'video/webm',
      ],
    ] as const
    for (const [name, header, mime] of media) {
      const source = Buffer.concat([
        Buffer.from(header, 'latin1'),
        Buffer.from('abcd'),
      ])
      await writeFile(join(root, name), source)
      const res = await transfers.preview(
        request({ Range: 'bytes=-4' }),
        ref(name),
        ok,
      )
      expect(res.status).toBe(206)
      expect(res.headers.get('content-type')).toBe(mime)
      expect(res.headers.get('content-disposition')).toStartWith('inline')
      expect(await res.text()).toBe('abcd')
    }
    for (const bytes of [[0xff], [65, 0, 66]]) {
      await writeFile(join(root, 'data.txt'), Buffer.from(bytes))
      const res = await transfers.preview(request(), ref('data.txt'), ok)
      expect(res.headers.get('content-disposition')).toStartWith('attachment')
      await res.body?.cancel()
    }
  })
  test('truncates displayed text and refuses invalid edits while keeping the file intact', async () => {
    const name = 'edit.txt',
      limit = 256 * 1024
    await writeFile(join(root, name), 'a'.repeat(limit) + 'extra')
    const preview = await transfers.preview(request(), ref(name), ok)
    expect(preview.headers.get('x-preview-truncated')).toBe('true')
    expect((await preview.text()).length).toBe(limit)
    const edit = (
      body: BodyInit,
      version: string | null,
      type = 'text/plain',
      method = 'PUT',
      target = name,
    ) =>
      transfers.editText(
        new Request(base, {
          method,
          headers: {
            'Content-Type': type,
            ...(version ? { 'If-Match': '"' + version + '"' } : {}),
          },
          body,
        }),
        ref(target),
        ok,
      )
    await expect(
      edit('new', preview.headers.get('x-file-version')),
    ).rejects.toThrow('local editor')
    await writeFile(join(root, name), 'small')
    const version = (await fs.stat(ref(name), ok)).version
    for (const body of [
      new Uint8Array([0xff]),
      new Uint8Array([0]),
      'a'.repeat(limit + 1),
    ])
      await expect(edit(body, version)).rejects.toThrow()
    await expect(edit('x', null)).rejects.toThrow()
    await expect(edit('x', version, 'application/json')).rejects.toThrow()
    await expect(edit('x', version, 'text/plain', 'POST')).rejects.toThrow()
    await expect(
      edit('x', version, 'text/plain', 'PUT', 'folder.svg'),
    ).rejects.toThrow()
    expect(await readFile(join(root, name), 'utf8')).toBe('small')
  })
  test('converts supported Linux raster formats into inline bounded WebP previews', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ2YAAAAASUVORK5CYII=',
      'base64',
    )
    const formats = {
      png,
      jpg: await new Bun.Image(png).jpeg().bytes(),
      webp: await new Bun.Image(png).webp().bytes(),
      gif: Buffer.from(
        'R0lGODdhAgACAIEAAP///wAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7',
        'base64',
      ),
      bmp: Buffer.from(
        'Qk1GAAAAAAAAADYAAAAoAAAAAgAAAAIAAAABABgAAAAAABAAAADEDgAAxA4AAAAAAAAAAAAA////////AAD///////8AAA==',
        'base64',
      ),
    }
    for (const [format, sample] of Object.entries(formats)) {
      const name = 'source.' + format
      await writeFile(join(root, name), sample)
      const preview = await transfers.preview(request(), ref(name), ok)
      expect(preview.headers.get('content-type')).toBe('image/webp')
      expect(preview.headers.get('content-disposition')).toStartWith('inline')
      const result = await new Bun.Image(await preview.bytes()).metadata()
      expect(result.format).toBe('webp')
      expect([result.width, result.height]).toEqual(
        ['gif', 'bmp'].includes(format) ? [2, 2] : [1, 1],
      )
    }
  })
  test('metadata-only preview discovery never starts a whole-file hash or sends original content', async () => {
    await writeFile(join(root, 'recording.bin'), Buffer.alloc(1024 * 1024, 25))
    const hashed: boolean[] = []
    const probe = new Request(base + '/_/preview?probe=1', { method: 'HEAD' })
    transfers.setPreparationTimeout(probe, (active) => hashed.push(active))
    const result = await transfers.preview(probe, ref('recording.bin'), ok)
    expect(result.status).toBe(200)
    expect(result.headers.get('content-disposition')).toStartWith('attachment')
    expect(result.headers.get('etag')).toBeNull()
    expect(hashed).toEqual([])
    expect(transfers.active()).toHaveLength(0)
    await expect(
      transfers.preview(new Request(probe.url), ref('recording.bin'), ok),
    ).rejects.toThrow('Use HEAD')
    const original = new Request(base + '/_/preview', { method: 'HEAD' })
    transfers.setPreparationTimeout(original, (active) => hashed.push(active))
    expect(
      (await transfers.preview(original, ref('recording.bin'), ok)).headers.get(
        'etag',
      ),
    ).toBeTruthy()
    expect(hashed).toEqual([true, false])
  })
  test('decodes and bounds a real thumbnail and rejects an incorrectly labelled input', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ2YAAAAASUVORK5CYII=',
      'base64',
    )
    await writeFile(join(root, 'pixel.png'), png)
    const response = await transfers.preview(
      new Request(base + '/_/preview?thumbnail=1'),
      ref('pixel.png'),
      ok,
    )
    expect(response.headers.get('content-type')).toBe('image/webp')
    const info = await new Bun.Image(await response.bytes()).metadata()
    expect(info.width).toBe(1)
    expect(info.height).toBe(1)
    await writeFile(join(root, 'mislabeled.jpg'), png)
    const mismatch = await transfers.preview(
      request(),
      ref('mislabeled.jpg'),
      ok,
    )
    expect(mismatch.headers.get('content-disposition')).toStartWith(
      'attachment',
    )
    await mismatch.body?.cancel()
    await writeFile(join(root, 'wrong.png'), 'Plain text')
    const rejected = await transfers.preview(request(), ref('wrong.png'), ok)
    expect(rejected.headers.get('content-disposition')).toStartWith(
      'attachment',
    )
    await rejected.body!.cancel()
  })

  test('previews bounded text and returns attachments for active formats and mismatched media', async () => {
    await writeFile(join(root, 'sample.md'), '# Heading\n')
    await writeFile(join(root, 'sample.html'), 'A tiny document.')
    await writeFile(join(root, 'track.wav'), 'A tiny document.')
    for (const name of ['sample.html', 'track.wav']) {
      const res = await transfers.preview(request(), ref(name), ok)
      expect(res.headers.get('content-disposition')).toStartWith('attachment')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      await res.body!.cancel()
    }
    const res = await transfers.preview(request(), ref('sample.md'), ok)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe('# Heading\n')
    const version = res.headers.get('x-file-version')!
    const edit = (v: string) =>
      transfers.editText(
        new Request(base, {
          method: 'PUT',
          headers: { 'content-type': 'text/plain', 'if-match': '"' + v + '"' },
          body: 'updated',
        }),
        ref('sample.md'),
        ok,
      )
    expect((await edit(version)).status).toBe(204)
    await expect(edit(version)).rejects.toThrow()
    expect(await readFile(join(root, 'sample.md'), 'utf8')).toBe('updated')
    await unlink(join(root, 'sample.md'))
  })
})
