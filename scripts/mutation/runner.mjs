import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { prepareWorkerd, observeWorkerd } from '../coverage/workerd.mjs'
import { declareClassPlugin, PluginKind } from '@stryker-mutator/api/plugin'
import {
  DryRunStatus,
  MutantRunStatus,
  TestStatus,
} from '@stryker-mutator/api/test-runner'

const work = '.quality/mutation-runtime'
const planFile = join(work, 'suites.json')
const testPattern = /\.test\.[cm]?[jt]sx?$/

async function discover(folder) {
  const results = []
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await discover(file)))
    } else if (testPattern.test(file) || file.endsWith('.e2e.ts'))
      results.push(file)
  }
  return results.sort()
}

// Bound captured diagnostics even for a mutant that loops or emits logs.
function run(
  args,
  env,
  activeProcesses,
  maxOutput = 48000,
  collectStdout = false,
) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), {
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    activeProcesses.add(child)
    let output = ''
    let stdout = ''
    const capture = (chunk) => {
      output = (output + chunk.toString()).slice(-maxOutput)
    }
    child.stdout.on('data', (chunk) => {
      capture(chunk)
      if (collectStdout) stdout = (stdout + chunk.toString()).slice(-maxOutput)
    })
    child.stderr.on('data', capture)
    child.once('error', reject)
    child.once('close', (code, signal) => {
      activeProcesses.delete(child)
      resolve({ code, signal, output, stdout })
    })
  })
}

async function traceIds(directory) {
  const result = {}
  for (const filename of await readdir(directory)) {
    if (filename.endsWith('.hits')) {
      const base = Number(filename.match(/-(\d+)\.hits$/)?.[1])
      const data = await readFile(join(directory, filename))
      if (!Number.isSafeInteger(base) || data.length !== 65536)
        throw new Error('Invalid mutation coverage page.')
      for (let i = 0; i < data.length; i++) if (data[i]) result[base + i] = 1
      continue
    }
    if (!filename.endsWith('.ids')) continue
    for (const id of (await readFile(join(directory, filename), 'utf8')).split(
      '\n',
    )) {
      if (!id) continue
      if (!/^\d+$/.test(id))
        throw new Error('Invalid mutation coverage ID: ' + id)
      result[id] = 1
    }
  }
  return result
}

async function prepareSandbox() {
  if (!process.cwd().split(/[\\/]/).includes('.stryker-tmp'))
    throw new Error('The Bun mutation runner requires a Stryker sandbox.')
  await mkdir(work, { recursive: true })
  // Only the scratch tree contains these lifecycle hooks.
  await writeFile(
    'bunfig.toml',
    'preload=["./scripts/mutation/native.mjs"]\n[test]\npreload=["./scripts/mutation/native.mjs"]\n',
    { flag: 'wx' },
  )
  for (const [path, wrapper] of [
    ['e2e.config.ts', './scripts/mutation/browser.mjs'],
    ['cloudflare/e2e.config.ts', '../scripts/mutation/browser.mjs'],
  ]) {
    const config = await readFile(path, 'utf8')
    const browserImport = /(['"])@e2e-dev\/web\1/g
    if (Array.from(config.matchAll(browserImport)).length !== 1)
      throw new Error('Expected the configured e2e web engine in ' + path)
    await writeFile(
      path,
      config.replace(browserImport, JSON.stringify(wrapper)),
    )
  }
  await prepareWorkerd(process.cwd())
  const files = [
    ...(await discover('tests')),
    ...(await discover('scripts')),
    ...(await discover('cloudflare/browser')),
  ]
  for (const path of files.filter((f) => f.endsWith('.e2e.ts'))) {
    const helper = relative(dirname(path), 'scripts/mutation/browser.mjs')
    const hook =
      'import {afterEach as __sa} from "@e2e-dev/web";import {finish as __sf} from ' +
      JSON.stringify(helper) +
      ';__sa(async ({browser})=>{await __sf(browser)});\n'
    await writeFile(path, hook + (await readFile(path, 'utf8')))
  }
  return files
}

class BunMutationRunner {
  children = new Set()
  lastKiller = new Map()
  disconnected = () => this.stop()
  terminated = () => {
    this.stop()
    process.exit(143)
  }
  async init() {
    process.once('disconnect', this.disconnected)
    process.once('SIGTERM', this.terminated)
    process.once('SIGINT', this.terminated)
  }
  capabilities() {
    return { reloadEnvironment: true }
  }
  async execute(suite, env) {
    if (suite.kind === 'native') {
      const report = join(work, 'bun-' + randomUUID() + '.xml')
      try {
        const result = await run(
          [
            'bun',
            'test',
            '--no-orphans',
            '--bail=1',
            '--timeout=30000',
            '--reporter=junit',
            '--reporter-outfile',
            report,
            ...suite.args,
          ],
          env,
          this.children,
        )
        if (result.code === 0) return result
        // Bun's reporter distinguishes AssertionError, TimeoutError and arbitrary
        // setup/teardown exceptions. An inconclusive suite can never establish a kill.
        const xml = await readFile(report, 'utf8').catch(() => '')
        const failures = [...xml.matchAll(/^\s*<failure type="([^"]+)"/gm)]
        const declared = Number(
          xml.match(/<testsuites [^>]*\bfailures="(\d+)"/)?.[1],
        )
        if (
          failures.length &&
          failures.length === declared &&
          failures.every((entry) => entry[1] === 'AssertionError')
        )
          return result
        return {
          ...result,
          infrastructure: true,
          output: 'Bun did not report an assertion failure.\n' + result.output,
        }
      } finally {
        await rm(report, { force: true })
      }
    }
    const cloud = suite.id.startsWith('cloudflare/browser/')
    const output = join(cloud ? 'cloudflare' : '.', work, 'e2e-' + randomUUID())
    if (cloud)
      await observeWorkerd(
        process.cwd(),
        env.LSHARE_MUTATION_TRACE ?? null,
        'mutation',
        env.__STRYKER_ACTIVE_MUTANT__ ?? null,
      )
    try {
      const result = await run(
        [
          'bun',
          'run',
          '--no-orphans',
          cloud ? 'scripts/cloud-fixture.ts' : 'scripts/e2e.ts',
          ...(cloud ? ['--browser-only'] : []),
          ...suite.args,
          '--exclude-tag',
          'agent',
          '--max-failures',
          '1',
          '--retries',
          '0',
          '--workers',
          '1',
          '--output',
          resolve(output),
        ],
        env,
        this.children,
      )
      const path = join(output, 'report.json')
      try {
        const report = JSON.parse(await readFile(path, 'utf8')).run
        if (report.summary.executed === 0)
          throw new Error('Browser runner executed zero cases')
        // Configuration and engine failures are infrastructure, never killed mutants.
        if (result.code !== 0) {
          const failed = report.results.filter(
            (test) => test.status === 'failed',
          )
          if (
            !failed.length ||
            !failed.every(
              (test) =>
                test.kind === 'test' &&
                test.attempts.at(-1)?.error?.category === 'test' &&
                test.attempts.at(-1)?.error?.phase === 'body' &&
                !/TIMEOUT|DEADLINE/.test(test.attempts.at(-1).error.code),
            )
          )
            return { ...result, infrastructure: true }
        }
      } catch (error) {
        return {
          ...result,
          infrastructure: true,
          output: result.output + '\n' + error,
        }
      }
      return result
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  }
  async dryRun(options) {
    try {
      if (options.coverageAnalysis !== 'perTest')
        throw new Error('Bun mutation runner requires perTest coverage.')
      const files = await prepareSandbox()
      const browserFiles = new Set()
      for (const cloud of [false, true]) {
        const selection = await run(
          [
            'node',
            'node_modules/e2e/dist/cli/bin.js',
            'list',
            ...(cloud ? ['--config', 'cloudflare/e2e.config.ts'] : []),
            '--reporter',
            'json',
            '--exclude-tag',
            'agent',
          ],
          {
            ...process.env,
            E2E_FIXTURE_OIDC: '1',
            ...(cloud
              ? {
                  E2E_APP_URL: 'http://127.0.0.1:1',
                  E2E_MAIL_SPOOL: resolve(work),
                }
              : {}),
          },
          this.children,
          4_000_000,
          true,
        )
        if (selection.code !== 0) throw new Error(selection.output)
        const selected = JSON.parse(selection.stdout)
          .pairs.filter((p) => p.disposition === 'run' && p.kind !== 'setup')
          .map((p) => (cloud ? join('cloudflare', p.file) : p.file))
        if (!selected.length || selected.some((path) => !files.includes(path)))
          throw new Error(
            'The browser selection contains missing or unknown suites.',
          )
        for (const path of selected) browserFiles.add(path)
      }
      const suites = files
        .filter((file) => testPattern.test(file) || browserFiles.has(file))
        .map((file) => ({
          id: file,
          kind: file.endsWith('.e2e.ts') ? 'browser' : 'native',
          args: [
            './' +
              (file.startsWith('cloudflare/browser/')
                ? relative('cloudflare', file)
                : file),
          ],
        }))
        .sort(
          (a, b) => Number(a.kind === 'browser') - Number(b.kind === 'browser'),
        )
      if (
        !browserFiles.size ||
        !suites.some((suite) => suite.kind === 'browser')
      )
        throw new Error('No deterministic browser suites discovered.')
      const tests = [],
        perTest = {}
      for (const suite of suites) {
        const raw = await mkdtemp(resolve(work, 'trace-'))
        try {
          const start = performance.now()
          const result = await this.execute(suite, {
            ...process.env,
            LSHARE_MUTATION_TRACE: raw,
          })
          if (result.code !== 0 || result.infrastructure)
            throw new Error(
              'Red baseline for ' + suite.id + '\n' + result.output,
            )
          suite.duration = Math.max(1, Math.round(performance.now() - start))
          perTest[suite.id] = await traceIds(raw)
          console.log(
            suite.id +
              ': ' +
              Object.keys(perTest[suite.id]).length +
              ' mutant sites hit in ' +
              suite.duration +
              ' ms',
          )
          tests.push({
            id: suite.id,
            name: suite.id,
            fileName: resolve(suite.id),
            timeSpentMs: suite.duration,
            status: TestStatus.Success,
          })
        } finally {
          await rm(raw, { recursive: true, force: true })
        }
      }
      await writeFile(planFile, JSON.stringify(suites))
      return {
        status: DryRunStatus.Complete,
        tests,
        mutantCoverage: { static: {}, perTest },
      }
    } catch (error) {
      return {
        status: DryRunStatus.Error,
        errorMessage: String(error.stack ?? error),
      }
    }
  }
  async mutantRun({ activeMutant, testFilter, timeout }) {
    this.suites ??= JSON.parse(await readFile(planFile, 'utf8'))
    const wanted = testFilter ? new Set(testFilter) : null
    // Adjacent mutations often fail the same assertion. Reorder only suites
    // proven to cover this candidate; survivors still run every eligible suite.
    const lineKey =
      activeMutant.fileName + ':' + activeMutant.location.start.line
    const likely =
      this.lastKiller.get(lineKey) ?? this.lastKiller.get(activeMutant.fileName)
    const covering = this.suites
      .filter((s) => !wanted || wanted.has(s.id))
      .sort(
        (a, b) =>
          Number(b.id === likely) - Number(a.id === likely) ||
          a.duration - b.duration,
      )
    if (wanted && covering.length !== wanted.size)
      return {
        status: MutantRunStatus.Error,
        errorMessage: 'Unknown test ID in mutation filter.',
      }
    let inconclusive = ''
    let tested = 0,
      expired = false
    const timer = setTimeout(() => {
      expired = true
      this.stop()
    }, timeout)
    try {
      for (const suite of covering) {
        const result = await this.execute(suite, {
          ...process.env,
          __STRYKER_ACTIVE_MUTANT__: activeMutant.id,
        })
        tested++
        if (expired)
          return inconclusive
            ? { status: MutantRunStatus.Error, errorMessage: inconclusive }
            : { status: MutantRunStatus.Timeout }
        if (result.infrastructure || result.signal || result.code === null) {
          inconclusive =
            suite.id + ': ' + (result.output || String(result.signal))
          continue
        }
        if (result.code !== 0) {
          this.lastKiller.set(lineKey, suite.id)
          this.lastKiller.set(activeMutant.fileName, suite.id)
          return {
            status: MutantRunStatus.Killed,
            killedBy: [suite.id],
            failureMessage: result.output,
            nrOfTests: tested,
          }
        }
      }
      if (inconclusive)
        return { status: MutantRunStatus.Error, errorMessage: inconclusive }
      return { status: MutantRunStatus.Survived, nrOfTests: tested }
    } finally {
      clearTimeout(timer)
    }
  }
  stop() {
    const roots = [...this.children].map((child) => child.pid).filter(Boolean)
    if (!roots.length) return
    // Playwright can launch browsers in separate process groups. Resolve the
    // descendant tree while its parents still exist, before terminating them.
    const result = spawnSync('ps', ['-eo', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 2000,
    })
    const children = new Map()
    for (const row of (result.stdout ?? '').trim().split('\n')) {
      const [pid, parent] = row.trim().split(/\s+/).map(Number)
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(pid)
    }
    const tree = [...roots]
    for (const parent of tree) tree.push(...(children.get(parent) ?? []))
    for (const pid of [...tree.reverse(), ...roots.map((root) => -root)]) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    this.children.clear()
  }
  async dispose() {
    process.off('disconnect', this.disconnected)
    process.off('SIGTERM', this.terminated)
    process.off('SIGINT', this.terminated)
    this.stop()
  }
}
export const strykerPlugins = [
  declareClassPlugin(PluginKind.TestRunner, 'lshare-bun', BunMutationRunner),
]
