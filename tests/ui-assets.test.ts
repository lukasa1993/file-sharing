import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildUiAssets, compileUiAssets } from '../app/ui/assets.ts'

test('serves both shipped hydration bundles directly from the deployment asset directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fileserver-ui-assets-'))
  try {
    const compiled = await compileUiAssets()
    for (const [name, blob] of compiled)
      await writeFile(
        join(directory, name),
        new Uint8Array(await blob.arrayBuffer()),
      )
    const built = await buildUiAssets(directory)
    expect([...built.keys()].sort()).toEqual([
      'hydrate-login.js',
      'login-client.js',
    ])
    for (const [name, file] of built) {
      expect(file.type).toStartWith('text/javascript')
      expect(await file.arrayBuffer()).toEqual(
        await compiled.get(name)!.arrayBuffer(),
      )
    }
    await rm(join(directory, 'hydrate-login.js'))
    await expect(buildUiAssets(directory)).rejects.toThrow(
      'Prebuilt UI asset is missing: hydrate-login.js',
    )
    await expect(buildUiAssets('relative-assets')).rejects.toThrow(
      'must be absolute',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
