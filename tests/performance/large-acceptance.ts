import assert from 'node:assert/strict'
import { createHash, randomFillSync } from 'node:crypto'
import {
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  statfs,
  type FileHandle,
} from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, type Fixture } from './large-acceptance-fixture.ts'

const MiB = 1024 ** 2
const GiB = 1024 ** 3
const block = 8 * MiB
const name = 'acceptance.bin'
export const defaultBytes = 101 * GiB
export type Mode = 'allocated' | 'sparse-download'
type Progress = (phase: string, bytes: number) => void

async function volume(path: string) {
  const canonical = await realpath(path)
  const directory = await stat(canonical)
  assert.ok(
    directory.isDirectory(),
    'Scratch location must be an existing directory',
  )
  const fs = await statfs(canonical, { bigint: true })
  return {
    path: canonical,
    device: directory.dev,
    free: Number(fs.bavail * fs.bsize),
    reserve: Math.min(
      8 * GiB,
      Math.max(GiB, Math.ceil(Number(fs.blocks * fs.bsize) / 20)),
    ),
  }
}
async function capacity(
  server: string,
  receiver: string,
  size: number,
  mode: Mode,
) {
  const source = await volume(server)
  const dest = mode === 'allocated' ? await volume(receiver) : source
  const requirements =
    mode === 'sparse-download'
      ? [[source, 16 * MiB] as const]
      : source.device === dest.device
        ? [[source, 2 * size] as const]
        : [[source, size] as const, [dest, size] as const]
  for (const [fs, bytes] of requirements) {
    if (fs.free < bytes + fs.reserve) {
      throw new Error(
        'Insufficient scratch capacity: need ' +
          bytes +
          ' bytes plus ' +
          fs.reserve +
          ' reserved, have ' +
          fs.free +
          ' at ' +
          fs.path,
      )
    }
  }
  return { source, dest }
}
async function guardSpace(root: Awaited<ReturnType<typeof volume>>) {
  const fs = await statfs(root.path, { bigint: true })
  assert.ok(
    Number(fs.bavail * fs.bsize) > root.reserve + block,
    'Scratch space fell below reserved headroom',
  )
}
function checkpoint(size: number) {
  for (const threshold of [100 * GiB, 2 * GiB])
    if (size > threshold + 8193) return threshold + 8193
  return Math.floor(size / 2)
}
async function checksum(file: string, signal: AbortSignal) {
  const hash = createHash('sha256')
  const handle = await open(file, 'r')
  const buffer = Buffer.allocUnsafe(block)
  try {
    for (;;) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(buffer)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}
async function writeBytes(
  file: FileHandle,
  bytes: Uint8Array,
  position: number,
) {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(
      bytes,
      offset,
      bytes.length - offset,
      position + offset,
    )
    assert.ok(bytesWritten)
    offset += bytesWritten
  }
}
async function upload(
  app: Fixture,
  size: number,
  signal: AbortSignal,
  checkSpace: () => Promise<void>,
  progress: Progress,
) {
  const protocol = { ...app.headers, 'Tus-Resumable': '1.0.0' }
  const metadata = Object.entries({ mount: 'acceptance', filename: name })
    .map(([key, value]) => key + ' ' + Buffer.from(value).toString('base64'))
    .join(',')
  const created = await app.request('/_/uploads', {
    method: 'POST',
    headers: {
      ...protocol,
      'Upload-Length': String(size),
      'Upload-Metadata': metadata,
    },
  })
  assert.equal(
    created.status,
    201,
    'Upload creation failed: ' + (await created.text()),
  )
  const resource = created.headers.get('location')
  assert.ok(resource)
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(block)
  const split = checkpoint(size)
  let offset = 0,
    nextCheck = 0
  const started = performance.now()
  while (offset < size) {
    signal.throwIfAborted()
    if (offset >= nextCheck) {
      await checkSpace()
      progress('upload', offset)
      nextCheck = offset + 256 * MiB
    }
    const length = Math.min(block, (offset < split ? split : size) - offset)
    const bytes = buffer.subarray(0, length)
    randomFillSync(bytes)
    hash.update(bytes)
    const response = await app.request(resource, {
      method: 'PATCH',
      headers: {
        ...protocol,
        'Upload-Offset': String(offset),
        'Content-Type': 'application/offset+octet-stream',
      },
      body: bytes,
    })
    assert.equal(
      response.status,
      204,
      'Upload chunk failed: ' + (await response.text()),
    )
    offset += length
    assert.equal(response.headers.get('Upload-Offset'), String(offset))
    if (offset === split) {
      await app.restart()
      const restored = await app.request(resource, {
        method: 'HEAD',
        headers: protocol,
      })
      assert.equal(restored.status, 200)
      assert.equal(restored.headers.get('Upload-Offset'), String(split))
      assert.equal(restored.headers.get('Upload-Length'), String(size))
    }
  }
  return {
    confirmedBytes: offset,
    resumedAt: split,
    elapsedMs: Math.round(performance.now() - started),
    sha256: hash.digest('hex'),
  }
}
async function sparseSource(path: string, size: number) {
  const points = [0, Math.floor(size / 3), checkpoint(size) - 13, size - 43]
  const handle = await open(path, 'wx', 0o600)
  try {
    // Verify holes work on the chosen volume before asking it for a 101 GiB file.
    await handle.truncate(block)
    await writeBytes(handle, Buffer.from([1]), block - 1)
    const probe = await handle.stat()
    assert.ok(
      probe.blocks * 512 < block / 2,
      'Scratch filesystem must support sparse files',
    )
    await handle.truncate(0)
    await handle.truncate(size)
    for (const [index, position] of points.entries())
      await writeBytes(
        handle,
        Buffer.from('LShare region ' + index + ' ' + position),
        position,
      )
    await handle.sync()
  } finally {
    await handle.close()
  }
  return points
}
async function allocation(path: string, size: number) {
  const info = await stat(path)
  assert.ok(info.isFile())
  assert.equal(info.size, size)
  return info.blocks * 512
}

async function download(
  app: Fixture,
  path: string,
  size: number,
  receiver: string | undefined,
  checkSpace: () => Promise<void>,
  progress: Progress,
) {
  const split = checkpoint(size)
  const hash = createHash('sha256')
  let etag: string | null = null
  let consumed = 0,
    bodyBytes = 0,
    nextCheck = 0
  const started = performance.now()
  for (const resumed of [false, true]) {
    if (resumed && receiver) assert.equal((await stat(receiver)).size, split)
    const cancel = new AbortController()
    const start = consumed
    const headers = new Headers({ 'Accept-Encoding': 'identity' })
    if (resumed) {
      assert.ok(etag)
      headers.set('Range', 'bytes=' + start + '-')
      headers.set('If-Range', etag)
    }
    const response = await app.request(path, { headers, signal: cancel.signal })
    assert.equal(response.status, resumed ? 206 : 200)
    assert.equal(response.headers.get('Content-Length'), String(size - start))
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes')
    assert.equal(response.headers.get('Content-Encoding'), null)
    assert.ok(response.headers.get('Content-Disposition')?.includes(name))
    if (resumed) {
      assert.equal(response.headers.get('ETag'), etag)
      assert.equal(
        response.headers.get('Content-Range'),
        'bytes ' + start + '-' + (size - 1) + '/' + size,
      )
    } else {
      etag = response.headers.get('ETag')
      assert.match(etag ?? '', /^"[^"]+"$/)
    }
    const reader = response.body?.getReader()
    assert.ok(reader)
    const handle = receiver
      ? await open(receiver, resumed ? 'r+' : 'wx', 0o600)
      : undefined
    try {
      const end = resumed ? size : split
      while (consumed < end) {
        const { value, done }: Awaited<ReturnType<typeof reader.read>> =
          await reader.read()
        assert.ok(!done && value?.byteLength, 'Premature HTTP EOF')
        if (resumed)
          assert.ok(
            value.byteLength <= end - consumed,
            'Unexpected trailing HTTP bytes',
          )
        bodyBytes += value.byteLength
        // This is the range actually accepted by the receiver. A socket read
        // straddling the interruption can also contain a small discarded tail.
        const bytes = value.subarray(
          0,
          Math.min(value.byteLength, end - consumed),
        )
        hash.update(bytes)
        if (handle) await writeBytes(handle, bytes, consumed)
        consumed += bytes.byteLength
        if (consumed >= nextCheck) {
          await checkSpace()
          progress('download', consumed)
          nextCheck = consumed + 256 * MiB
        }
      }
      if (resumed)
        assert.equal(
          (await reader.read()).done,
          true,
          'Unexpected trailing HTTP bytes',
        )
      else cancel.abort()
      await handle?.sync()
    } finally {
      cancel.abort()
      await reader.cancel().catch(() => {})
      await handle?.close()
    }
  }
  assert.equal(consumed, size)
  return {
    verifiedPayloadBytes: consumed,
    httpBodyBytesRead: bodyBytes,
    resumedAt: split,
    etag,
    elapsedMs: Math.round(performance.now() - started),
    sha256: hash.digest('hex'),
  }
}

export async function runLargeAcceptance(options: {
  directory: string
  receiverDirectory?: string
  bytes: number
  mode: Mode
  signal: AbortSignal
  progress?: Progress
}) {
  const { bytes, signal, mode } = options
  assert.ok(
    Number.isSafeInteger(bytes) &&
      bytes >= 4096 &&
      bytes <= Number.MAX_SAFE_INTEGER / 2,
    'Choose a safe integer byte count of at least 4096',
  )
  const progress = options.progress ?? (() => {})
  const volumes = await capacity(
    options.directory,
    options.receiverDirectory ?? options.directory,
    bytes,
    mode,
  )
  const serverRoot = await mkdtemp(
    join(volumes.source.path, 'lshare-acceptance-'),
  )
  let clientRoot: string | undefined
  let app: Fixture | undefined
  const started = performance.now()
  const clientBaseline = process.memoryUsage.rss()
  try {
    if (mode === 'allocated')
      clientRoot = await mkdtemp(join(volumes.dest.path, 'lshare-receiver-'))
    const state = join(serverRoot, 'state')
    app = await fixture(state, signal)
    const file = join(state, 'storage', name)
    const uploaded =
      mode === 'allocated'
        ? await upload(
            app,
            bytes,
            signal,
            () => guardSpace(volumes.source),
            progress,
          )
        : null
    const sparseMarkerOffsets =
      mode === 'sparse-download' ? await sparseSource(file, bytes) : null
    const sourceAllocatedBytes = await allocation(file, bytes)
    if (uploaded)
      assert.ok(
        sourceAllocatedBytes >= bytes,
        'Source data must have physically allocated blocks',
      )
    const url = await app.share(name)
    const received = clientRoot ? join(clientRoot, 'received.bin') : undefined
    progress('cold public download', 0)
    const downloaded = await download(
      app,
      url,
      bytes,
      received,
      () => (received ? guardSpace(volumes.dest) : Promise.resolve()),
      progress,
    )
    progress('verify source', bytes)
    const sourceSha256 = await checksum(file, signal)
    assert.equal(downloaded.sha256, sourceSha256)
    assert.equal(downloaded.etag, '"' + sourceSha256 + '"')
    if (uploaded) assert.equal(uploaded.sha256, sourceSha256)
    const receiverAllocatedBytes = received
      ? await allocation(received, bytes)
      : null
    if (received) {
      assert.ok(
        receiverAllocatedBytes !== null && receiverAllocatedBytes >= bytes,
        'Receiver data must have physically allocated blocks',
      )
      assert.equal(await checksum(received, signal), sourceSha256)
    }
    const serverRss = await app.memory()
    const clientRss = {
      baselineBytes: clientBaseline,
      peakBytes: process.resourceUsage().maxRSS * 1024,
    }
    return {
      mode,
      arch: process.arch,
      runtime: 'Bun ' + Bun.version,
      logicalBytes: bytes,
      freeAtPreflight: {
        server: volumes.source.free,
        receiver: volumes.dest.free,
      },
      sourceAllocatedBytes,
      receiverAllocatedBytes,
      sparseMarkerOffsets,
      upload: uploaded,
      download: downloaded,
      serverRss,
      clientRss,
      elapsedMs: Math.round(performance.now() - started),
    }
  } finally {
    try {
      await app?.stop()
    } finally {
      await Promise.all([
        rm(serverRoot, { recursive: true, force: true }),
        clientRoot
          ? rm(clientRoot, { recursive: true, force: true })
          : undefined,
      ])
    }
  }
}
