// Hooks registered per test file only in the instrumented copy of the project.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function startBrowserCoverage(browser) {
  await browser.addInitScript(
    (prefix) => {
      if (location.origin === 'null') return
      globalThis.__fileserverPrefix = prefix
      const key = prefix + crypto.getRandomValues(new Uint32Array(4)).join('-')
      function save() {
        const all = globalThis.__coverage__
        if (!all || !Object.keys(all).length) return
        const counters = Object.fromEntries(
          Object.entries(all).map(([path, { s, f, b }]) => [path, { s, f, b }]),
        )
        sessionStorage.setItem(key, JSON.stringify(counters))
      }
      globalThis.__fileserverSnapshot = save
      window.addEventListener('pagehide', save)
    },
    '__fileserver_istanbul__:' + randomUUID() + ':',
  )
}

export async function finishBrowserCoverage(browser, directory) {
  const snapshots = await browser.evaluate(() => {
    const prefix = globalThis.__fileserverPrefix
    if (location.origin === 'null' || !prefix) return []
    globalThis.__fileserverSnapshot?.()
    return Object.keys(sessionStorage)
      .filter((key) => key.startsWith(prefix))
      .map((key) => JSON.parse(sessionStorage.getItem(key)))
  })
  for (const snapshot of snapshots) {
    await writeFile(
      join(directory, 'browser-' + randomUUID() + '.json'),
      JSON.stringify({ complete: true, files: snapshot }),
      { flag: 'wx', mode: 0o600 },
    )
  }
}
