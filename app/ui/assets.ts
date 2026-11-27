import { basename, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function buildUiAssets(): Promise<Map<string, Blob>> {
  const directory = process.env.UI_ASSETS_DIR
  if (directory) {
    if (!isAbsolute(directory))
      throw new Error('UI_ASSETS_DIR must be absolute.')
    const assets = new Map<string, Blob>()
    for (const name of ['login-client.js', 'hydrate-login.js']) {
      const asset = Bun.file(join(directory, name), {
        type: 'text/javascript; charset=utf-8',
      })
      if (!(await asset.exists()))
        throw new Error('Prebuilt UI asset is missing: ' + name)
      assets.set(name, asset)
    }
    return assets
  }
  return compileUiAssets()
}

export async function compileUiAssets(): Promise<Map<string, Blob>> {
  const result = await Bun.build({
    entrypoints: ['login-client.tsx', 'hydrate-login.ts'].map((file) =>
      fileURLToPath(new URL('./' + file, import.meta.url)),
    ),
    target: 'browser',
    format: 'esm',
    minify: true,
    splitting: false,
  })
  if (!result.success)
    throw new Error(
      'Unable to build login assets: ' +
        result.logs.map((log) => log.message).join('\n'),
    )
  return new Map(result.outputs.map((asset) => [basename(asset.path), asset]))
}
