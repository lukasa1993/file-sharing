import { copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
export async function stageCloudAssets(
  destination = resolve(root, '.cloudflare/assets'),
) {
  await mkdir(dirname(destination), { recursive: true })
  const staging = await mkdtemp(join(dirname(destination), 'assets-'))
  try {
    const assets = join(staging, 'assets')
    await mkdir(assets)
    for (const [source, name] of [
      ['cloudflare/assets/cloud.css', 'cloud.css'],
      ['cloudflare/assets/cloud.js', 'cloud.js'],
      ['public/lshare-mark.png', 'lshare-mark.png'],
      ['public/lshare-folio.webp', 'lshare-folio.webp'],
      ['public/transfer-client.js', 'transfer-client.js'],
    ] as const)
      await copyFile(join(root, source), join(assets, name))
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
if (import.meta.main) await stageCloudAssets()
