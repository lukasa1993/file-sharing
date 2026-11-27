import { expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLargeAcceptance } from './large-acceptance.ts'

test.each(['allocated', 'sparse-download'] as const)(
  'operator acceptance verifies both HTTP legs and disposes the %s fixture',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'lshare-acceptance-test-'))
    const bytes = 4 * 1024 ** 2 + 123
    try {
      const result = await runLargeAcceptance({
        directory,
        bytes,
        mode,
        signal: AbortSignal.timeout(50000),
      })
      expect(result.download.verifiedPayloadBytes).toBe(bytes)
      expect(result.download.httpBodyBytesRead).toBeGreaterThanOrEqual(bytes)
      expect(result.download.resumedAt).toBe(Math.floor(bytes / 2))
      expect(result.download.etag).toBe('"' + result.download.sha256 + '"')
      if (mode === 'allocated') {
        expect(result.upload?.sha256).toBe(result.download.sha256)
        expect(result.upload?.confirmedBytes).toBe(bytes)
        expect(result.sourceAllocatedBytes).toBeGreaterThanOrEqual(bytes)
        expect(result.receiverAllocatedBytes).toBeGreaterThanOrEqual(bytes)
      } else {
        expect(result.upload).toBeNull()
        expect(result.sourceAllocatedBytes).toBeLessThan(bytes)
        expect(result.sparseMarkerOffsets).toHaveLength(4)
      }
      expect(await readdir(directory)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  60000,
)

test('physical capacity rejection leaves scratch storage empty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lshare-capacity-test-'))
  try {
    await expect(
      runLargeAcceptance({
        directory,
        mode: 'allocated',
        bytes: 2 ** 51,
        signal: AbortSignal.timeout(10000),
      }),
    ).rejects.toThrow('Insufficient scratch capacity')
    expect(await readdir(directory)).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
