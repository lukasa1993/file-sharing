import { spawn } from 'node:child_process'
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
  const config = await readFile('e2e.config.ts', 'utf8')
  const browserImport = /(['"])@e2e-dev\/web\1/g
  if (Array.from(config.matchAll(browserImport)).length !== 1)
    throw new Error('Expected the configured e2e web engine.')
  await writeFile(
    'e2e.config.ts',
    config.replace(browserImport, '"./scripts/mutation/browser.mjs"'),
  )
  const files = [...(await discover('tests')), ...(await discover('scripts'))]
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
  capabilities() {
    return { reloadEnvironment: true }
  }
  async execute(suite, env) {
    if (suite.kind === 'native') {
      const result = await run(
        ['bun', 'test', '--bail=1', '--timeout=30000', ...suite.args],
        env,
        this.children,
      )
      if (
        result.code !== 0 &&
        !/\(fail\)|\b[1-9]\d* fail\b/.test(result.output)
      )
        return { ...result, infrastructure: true }
      return result
    }
    const output = join(work, 'e2e-' + randomUUID())
    try {
      const result = await run(
        [
          'bun',
          'scripts/e2e.ts',
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
          output,
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
              (test) => test.attempts.at(-1)?.error?.category === 'test',
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
      const selection = await run(
        [
          'node',
          'node_modules/e2e/dist/cli/bin.js',
          'list',
          '--reporter',
          'json',
          '--exclude-tag',
          'agent',
        ],
        { ...process.env, E2E_FIXTURE_OIDC: '1' },
        this.children,
        4_000_000,
        true,
      )
      if (selection.code !== 0) throw new Error(selection.output)
      const browserFiles = new Set(
        JSON.parse(selection.stdout)
          .pairs.filter((p) => p.disposition === 'run' && p.kind !== 'setup')
          .map((p) => p.file),
      )
      const suites = files
        .filter((file) => testPattern.test(file) || browserFiles.has(file))
        .map((file) => ({
          id: file,
          kind: file.endsWith('.e2e.ts') ? 'browser' : 'native',
          args: ['./' + file],
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
        if (expired) return { status: MutantRunStatus.Timeout }
        if (result.infrastructure || result.signal || result.code === null)
          return {
            status: MutantRunStatus.Error,
            errorMessage: result.output || String(result.signal),
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
      return { status: MutantRunStatus.Survived, nrOfTests: tested }
    } finally {
      clearTimeout(timer)
    }
  }
  stop() {
    for (const child of this.children) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
  }
  async dispose() {
    this.stop()
  }
}
export const strykerPlugins = [
  declareClassPlugin(PluginKind.TestRunner, 'lshare-bun', BunMutationRunner),
]
