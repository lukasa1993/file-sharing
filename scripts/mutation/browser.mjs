// The sandbox's e2e config imports this wrapper. The engine installs its
// script before app code in every document, including the first navigation.
import { web as createWeb } from '@e2e-dev/web'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'

export * from '@e2e-dev/web'

function recordPage({ active, trace, prefix }) {
  globalThis.__stryker__ = active === null ? {} : { activeMutant: active }
  if (!trace || location.origin === 'null') return
  globalThis.__lshareMutationPrefix = prefix
  const hits = new Proxy(Object.create(null), {
    set(target, key, value) {
      if (!Object.hasOwn(target, key)) sessionStorage.setItem(prefix + key, '1')
      target[key] = value
      return true
    },
  })
  globalThis.__stryker__.mutantCoverage = { static: hits, perTest: {} }
}

export function web(options) {
  const active = process.env.__STRYKER_ACTIVE_MUTANT__ ?? null
  const trace = Boolean(process.env.LSHARE_MUTATION_TRACE)
  if (active === null && !trace) return createWeb(options)
  const settings = { active, trace, prefix: '__lshare_mutation__:' }
  const script =
    '(' + recordPage.toString() + ')(' + JSON.stringify(settings) + ')'
  return createWeb({
    ...options,
    initScripts: [...(options.initScripts ?? []), script],
  })
}

export async function finish(browser) {
  const directory = process.env.LSHARE_MUTATION_TRACE
  if (!directory) return
  const ids = await browser.evaluate(() => {
    const prefix = globalThis.__lshareMutationPrefix
    if (!prefix) return []
    return Object.keys(sessionStorage)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
  })
  await writeFile(
    join(directory, 'web-' + randomUUID() + '.ids'),
    ids.join('\n'),
    {
      flag: 'wx',
      mode: 0o600,
    },
  )
}
