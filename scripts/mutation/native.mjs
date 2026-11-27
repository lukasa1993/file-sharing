// Loaded exclusively by the Stryker sandbox. Shared pages keep hits even when
// a lifecycle test deliberately kills a child process before its exit hooks.
import { closeSync, ftruncateSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = process.env.LSHARE_MUTATION_TRACE
if (directory) {
  const pages = new Map()
  const counters = new Proxy(Object.create(null), {
    set(target, key, value) {
      if (!Object.hasOwn(target, key)) {
        const id = Number(key)
        if (!Number.isSafeInteger(id) || id < 0)
          throw new Error('Invalid Stryker coverage ID ' + String(key))
        const base = Math.floor(id / 65536) * 65536
        let hits = pages.get(base)
        if (!hits) {
          const path = join(
            directory,
            'bun-' + crypto.randomUUID() + '-' + base + '.hits',
          )
          const fd = openSync(path, 'wx', 0o600)
          try {
            ftruncateSync(fd, 65536)
          } finally {
            closeSync(fd)
          }
          hits = Bun.mmap(path, { shared: true })
          pages.set(base, hits)
        }
        hits[id - base] = 1
      }
      target[key] = value
      return true
    },
  })
  globalThis.__stryker__ = { mutantCoverage: { static: counters, perTest: {} } }
}

// Fixture processes intentionally receive a restricted environment. Carry just
// the proof variables and the test preload into standalone Bun runtimes as well.
const inherited = {}
for (const key of ['LSHARE_MUTATION_TRACE', '__STRYKER_ACTIVE_MUTANT__'])
  if (process.env[key] !== undefined) inherited[key] = process.env[key]
if (Object.keys(inherited).length) {
  const original = Bun.spawn.bind(Bun)
  const preload = fileURLToPath(import.meta.url)
  Bun.spawn = (command, options) => {
    const argv = Array.isArray(command) ? command : command.cmd
    if (![process.execPath, 'bun'].includes(argv[0]))
      return Array.isArray(command)
        ? original(command, options)
        : original(command)
    const offset = ['run', 'test'].includes(argv[1]) ? 2 : 1
    const forwarded = [
      ...argv.slice(0, offset),
      '--preload',
      preload,
      ...argv.slice(offset),
    ]
    const settings = Array.isArray(command) ? options : command
    const env = { ...(settings?.env ?? process.env), ...inherited }
    return Array.isArray(command)
      ? original(forwarded, { ...options, env })
      : original({ ...command, cmd: forwarded, env })
  }
}
