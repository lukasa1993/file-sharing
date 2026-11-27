import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Filesystem } from '../app/filesystem/index.ts'
import { listenHttp } from '../app/transport.ts'
import { Transfers } from '../app/transfers/index.ts'

// FILESERVER_LARGE_RANGE=1 bun test tests/transfers-large.test.ts
// The full run hashes every logical byte on the first HTTP request. A sparse
// fixture measures offset handling and memory, independently of disk capacity.
const large = process.env.FILESERVER_LARGE_RANGE === '1'
const timeout = large ? 15 * 60_000 : 15_000

test(
  'cold native HTTP range and warm validator address the original tail bytes',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'fileserver-cold-http-'))
    const db = new Database(':memory:')
    let server: Awaited<ReturnType<typeof listenHttp>> | undefined
    let transfers: Transfers | undefined
    let sampling: ReturnType<typeof setInterval> | undefined
    try {
      const offset = large ? 101 * 1024 ** 3 : 2 * 1024 ** 2 + 1
      const tail = Buffer.from('End of sparse fixture')
      const size = offset + tail.byteLength
      await writeFile(join(root, '.fileserver-root'), 'range-test')
      const handle = await open(join(root, 'sparse.bin'), 'wx')
      try {
        await handle.write(tail, 0, tail.byteLength, offset)
        await handle.sync()
      } finally {
        await handle.close()
      }
      const fs = new Filesystem(
        [
          {
            id: 'test',
            label: 'Test',
            path: root,
            sentinel: 'range-test',
            readOnly: true,
          },
        ],
        db,
      )
      const service = new Transfers(db, fs)
      transfers = service
      const ref = { mountId: 'test', segments: ['sparse.bin'] }
      const transitions: boolean[] = []
      server = await listenHttp(
        { hostname: '127.0.0.1', port: 0 },
        (req, _peer, setPreparing) => {
          service.setPreparationTimeout(req, (preparing) => {
            transitions.push(preparing)
            setPreparing(preparing)
          })
          return service.download(req, ref, () => {})
        },
      )
      const baseline = process.memoryUsage.rss()
      let peak = baseline
      sampling = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage.rss())
      }, 50)
      const started = performance.now()
      const response = await fetch(server.url, {
        headers: { Range: 'bytes=' + offset + '-' },
        timeout: false,
        signal: AbortSignal.timeout(timeout - 1000),
      })
      expect(response.status).toBe(206)
      expect(response.headers.get('content-range')).toBe(
        `bytes ${offset}-${size - 1}/${size}`,
      )
      expect(response.headers.get('content-length')).toBe(
        String(tail.byteLength),
      )
      expect(Buffer.from(await response.arrayBuffer())).toEqual(tail)
      const warm = await fetch(server.url, { method: 'HEAD' })
      expect(warm.status).toBe(200)
      expect(warm.headers.get('content-length')).toBe(String(size))
      expect(warm.headers.get('etag')).toBe(response.headers.get('etag'))
      expect(transitions).toEqual([true, false])
      if (large) {
        console.log(
          JSON.stringify({
            bench: 'cold-http-range',
            offset,
            size,
            status: response.status,
            coldRangeAndWarmHeadMs: Math.round(performance.now() - started),
            sampledPeakRss: peak,
            sampledRssDelta: peak - baseline,
          }),
        )
        expect(peak - baseline).toBeLessThan(256 * 1024 ** 2)
      }
    } finally {
      clearInterval(sampling)
      await server?.stop(true)
      await transfers?.shutdown()
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  timeout,
)
