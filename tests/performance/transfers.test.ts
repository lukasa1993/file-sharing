import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir, machine } from 'node:os'
import { join } from 'node:path'
import { type Guard } from '../../app/contracts'
import { Filesystem } from '../../app/filesystem'
import { listenHttp } from '../../app/transport'
import { Downloads } from '../../app/transfers/downloads'
import { ActivityRegistry, chunks } from '../../app/transfers/streams'

test('concurrent native transfers retain bytes and bound process memory, including reads above 100 GiB', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'fileserver-perf-'))
  const db = new Database(':memory:')
  const jobs = new ActivityRegistry()
  const largeOffset = 101 * 1024 ** 3
  const mountId = 'bench'
  const large = 'sparse.bin'
  const allocated = 'measured.bin'
  const megabyte = 1024 ** 2
  const megabytes = 32
  const block = Buffer.alloc(megabyte, 0x7a)
  const expected = createHash('sha256')
  const guard: Guard = (action, ref) => {
    if (ref.mountId !== mountId || !['list', 'read'].includes(action))
      throw new Error('Unexpected fixture access')
  }
  let http: Awaited<ReturnType<typeof listenHttp>> | undefined
  try {
    await writeFile(join(storage, '.fileserver-root'), 'benchmark')
    const fs = new Filesystem(
      [
        {
          id: mountId,
          label: 'Bench',
          path: storage,
          readOnly: false,
          sentinel: 'benchmark',
        },
      ],
      db,
    )
    const sparse = await open(join(storage, large), 'wx')
    const endBytes = Buffer.from('64-bit-offset')
    try {
      await sparse.write(endBytes, 0, endBytes.length, largeOffset)
    } finally {
      await sparse.close()
    }
    const pinned = await fs.openRead({ mountId, segments: [large] }, guard)
    const tail: Buffer[] = []
    try {
      for await (const b of chunks(
        pinned.handle,
        largeOffset,
        largeOffset + endBytes.length,
      ))
        tail.push(b)
      expect(Buffer.concat(tail)).toEqual(endBytes)
    } finally {
      await pinned.handle.close()
    }

    const diskFile = await open(join(storage, allocated), 'wx')
    try {
      for (let n = 0; n < megabytes; n++) {
        await diskFile.writeFile(block)
        expected.update(block)
      }
      await diskFile.sync()
    } finally {
      await diskFile.close()
    }
    const downloads = new Downloads(fs, jobs)
    const file = { mountId, segments: [allocated] }
    http = await listenHttp({ hostname: '127.0.0.1', port: 0 }, (req) =>
      downloads.file(req, file, guard, {}, false),
    )
    const url = http.url
    const wanted = expected.digest('hex')
    const initialRSS = process.memoryUsage.rss()
    let peakRSS = initialRSS
    const start = performance.now()
    const readers = [0, 1, 2].map(async () => {
      const response = await fetch(url)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-length')).toBe(
        String(megabytes * megabyte),
      )
      expect(response.headers.has('transfer-encoding')).toBe(false)
      if (!response.body) throw new Error('Missing native transfer body.')
      const hash = createHash('sha256')
      for await (const b of response.body) {
        hash.update(b)
        peakRSS = Math.max(process.memoryUsage.rss(), peakRSS)
      }
      return hash.digest('hex')
    })
    expect(await Promise.all(readers)).toEqual([wanted, wanted, wanted])
    const delta = Math.max(0, peakRSS - initialRSS)
    console.info(
      JSON.stringify({
        bench: 'concurrent-downloads',
        bun: Bun.version,
        architecture: machine(),
        bytesPerClient: megabytes * megabyte,
        clients: readers.length,
        durationMs: Math.round(performance.now() - start),
        sampledPeakRss: peakRSS,
        sampledRssDelta: delta,
        sparseOffset: largeOffset,
      }),
    )
    expect(delta).toBeLessThan(256 * megabyte)
    // Known Content-Length lets clients finish immediately after the last byte,
    // while the server closes the pinned handles on its following pull.
    const releaseDeadline = AbortSignal.timeout(2000)
    while (jobs.list().length && !releaseDeadline.aborted) await Bun.sleep(5)
    expect(jobs.list()).toHaveLength(0)
  } finally {
    await http?.stop(true)
    db.close()
    await rm(storage, { recursive: true, force: true })
  }
}, 60_000)
