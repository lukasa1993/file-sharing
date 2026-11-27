import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileUiAssets } from '../app/ui/assets.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
export async function buildDistribution(dist = join(root, 'dist')) {
  const stage = await mkdtemp(join(dirname(dist), '.fileserver-build-'))
  const output = join(stage, 'output')
  const previous = join(stage, 'previous')

  try {
    const webAssets = await compileUiAssets()
    const result = await Bun.build({
      entrypoints: [join(root, 'server.ts')],
      target: 'bun',
      packages: 'external',
      format: 'esm',
      sourcemap: 'none',
      banner: `import {fileURLToPath as fileserverAssetPath} from 'node:url';
process.env.UI_ASSETS_DIR ??= fileserverAssetPath(new URL('../public/', import.meta.url));`,
    })
    if (!result.success)
      throw new AggregateError(result.logs, 'Server bundle failed')
    const server = result.outputs.find((item) => item.kind === 'entry-point')
    if (!server) throw new Error('Server build produced no entry point')

    await mkdir(join(output, 'app'), { recursive: true })
    await cp(join(root, 'public'), join(output, 'public'), { recursive: true })
    for (const [name, asset] of webAssets)
      await Bun.write(join(output, 'public', name), asset)
    await Bun.write(join(output, 'app/server.js'), server)
    let replaced = false
    try {
      await rename(dist, previous)
      replaced = true
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error
    }
    try {
      await rename(output, dist)
    } catch (error) {
      if (replaced) await rename(previous, dist)
      throw error
    }
    console.log(
      'Built dist/app/server.js and static browser assets in dist/public/.',
    )
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

if (import.meta.main) await buildDistribution()
