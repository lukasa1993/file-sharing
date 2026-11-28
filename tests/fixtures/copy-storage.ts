import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Mount } from '../../app/contracts.ts'

export async function addCopyStorage(state: string, sourceFixture = false) {
  const path = join(state, 'deliveries')
  await mkdir(path, { mode: 0o700 })
  const mount = {
    id: 'deliveries',
    label: 'Deliveries',
    path,
    readOnly: false,
    sentinel: randomUUID(),
  }
  await writeFile(join(path, '.fileserver-root'), mount.sentinel)
  const file = join(state, 'config/mounts.json')
  const config: { mounts: Mount[] } = JSON.parse(await readFile(file, 'utf8'))
  config.mounts.push(mount)
  await writeFile(file, JSON.stringify(config))
  if (sourceFixture) {
    const folder = join(path, 'Operation examples')
    await mkdir(folder)
    const fixture = await open(join(folder, 'Move sample.bin'), 'wx')
    try {
      // Holes keep an untouched source cheap. A real cross-root move stages
      // these bytes, so the browser has time to observe and cancel it.
      await fixture.truncate(2 * 1024 ** 3)
      await fixture.write(Buffer.from('original'), 0, 8, 0)
    } finally {
      await fixture.close()
    }
  }
}
