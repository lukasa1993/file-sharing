// Run only in a disposable container with TMPDIR=/capacity on a dedicated small tmpfs.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture } from '../tests/fixture.ts'

const directory = tmpdir()
assert.equal(directory, '/capacity')
const initial = await statfs(directory)
assert.equal(initial.type, 0x01021994, 'A disposable tmpfs is required')
assert.ok(initial.blocks * initial.bsize <= 32 * 1024 * 1024)
assert.equal(
  (await readdir(directory)).length,
  0,
  'The test volume must be empty',
)
const f = await fixture()
const filler = await mkdtemp(join(directory, 'capacity-check-'))
try {
  const owner = await f.signIn()
  const protocol = { ...owner, 'Tus-Resumable': '1.0.0' }
  const file = randomBytes(2 * 1024 * 1024)
  const filename = 'delivery.bin'
  const created = await f.fetch('/_/uploads', {
    method: 'POST',
    headers: {
      ...protocol,
      'Upload-Length': String(file.length),
      'Upload-Metadata':
        'mount ' +
        Buffer.from('e2e').toString('base64') +
        ',filename ' +
        Buffer.from(filename).toString('base64'),
    },
  })
  assert.equal(created.status, 201)
  const path = created.headers.get('location')
  assert.ok(path)
  const patch = (offset: number, end: number) =>
    f.fetch(path, {
      method: 'PATCH',
      headers: {
        ...protocol,
        'Upload-Offset': String(offset),
        'content-type': 'application/offset+octet-stream',
      },
      body: file.subarray(offset, end),
    })
  const confirmed = 131_071
  assert.equal((await patch(0, confirmed)).status, 204)
  const space = await statfs(directory)
  await writeFile(
    join(filler, 'occupied'),
    Buffer.alloc(space.bavail * space.bsize - 512 * 1024, 1),
    { flag: 'wx' },
  )
  const failed = await patch(confirmed, file.length)
  assert.equal(failed.status, 507)
  const head = await f.fetch(path, { method: 'HEAD', headers: protocol })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('upload-offset'), String(confirmed))
  assert.equal(await Bun.file(join(f.storage, filename)).exists(), false)
  await rm(filler, { recursive: true })
  assert.equal((await patch(confirmed, file.length)).status, 204)
  assert.deepEqual(await readFile(join(f.storage, filename)), file)
  console.log(
    'Verified HTTP 507 after a real partial write, durable offset, unpublished destination and byte-identical retry.',
  )
} finally {
  await rm(filler, { recursive: true, force: true })
  await f.close()
}
