// Installed only in the disposable instrumented tree via its bunfig.toml.
import { writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export function collectBunCounters(directory) {
  const kind = process.argv.some((arg) => /(?:^|\/)server\.ts$/.test(arg))
    ? 'server'
    : 'bun'
  const file = join(
    directory,
    kind + '-' + process.pid + '-' + crypto.randomUUID() + '.json',
  )
  let nativeTestRunner = false
  function flush(complete = false) {
    const all = globalThis.__coverage__
    if (!all || !Object.keys(all).length) return
    const data = Object.fromEntries(
      Object.entries(all).map(([path, { s, f, b }]) => [path, { s, f, b }]),
    )
    writeFileSync(
      file + '.tmp',
      JSON.stringify({ complete, nativeTestRunner, files: data }),
      {
        mode: 0o600,
      },
    )
    renameSync(file + '.tmp', file)
  }
  // SIGKILL cannot run an exit handler. Only publish real observations, and
  // periodically checkpoint long-lived processes used by crash-recovery tests.
  const timer = setInterval(flush, 250)
  timer.unref()
  process.once('exit', () => flush(true))
  return () => {
    nativeTestRunner = true
    clearInterval(timer)
    flush(true)
  }
}
