import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInstrumenter } from 'istanbul-lib-instrument'
import { createCollector } from './merge.mjs'
import { createContext } from 'istanbul-lib-report'
import reports from 'istanbul-reports'
import { sourceFiles, critical } from '../quality-sources.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'fileserver-istanbul-'))
const output = resolve(root, '.quality/coverage')
const raw = join(temp, 'observations')
const files = await sourceFiles()
const seed = {}
const originals = new Map()
const runFailures = []
const testInputs = {}
const evidence = join(output, 'evidence.json')
const digest = (source) => createHash('sha256').update(source).digest('hex')

async function execute(name, args, env = process.env) {
  console.log('Coverage suite: ' + name)
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: temp,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  })
  if ((await child.exited) !== 0) runFailures.push(name)
}

async function stage() {
  for (const name of [
    'app',
    'public',
    'scripts',
    'tests',
    'e2e.config.ts',
    'server.ts',
    'tsconfig.json',
    'package.json',
  ]) {
    await cp(join(root, name), join(temp, name), { recursive: true })
  }
  for (const folder of ['scripts', 'tests']) {
    for await (const path of new Bun.Glob('**/*').scan({
      cwd: join(temp, folder),
      onlyFiles: true,
    })) {
      const name = folder + '/' + path
      testInputs[name] = digest(await readFile(join(temp, name)))
    }
  }
  for (const name of ['e2e.config.ts', 'tsconfig.json', 'package.json'])
    testInputs[name] = digest(await readFile(join(temp, name)))
  await mkdir(raw)
  await symlink(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir')
  const preload = join(temp, 'coverage-preload.mjs')
  await writeFile(
    preload,
    'import {collectBunCounters} from "./scripts/coverage/bun.mjs";export const flushTestSuite = collectBunCounters(' +
      JSON.stringify(raw) +
      ');\n',
  )
  await writeFile(
    join(temp, 'coverage-test-preload.mjs'),
    'import {afterAll} from "bun:test";import {flushTestSuite} from "./coverage-preload.mjs";afterAll(flushTestSuite);\n',
  )
  await writeFile(
    join(temp, 'bunfig.toml'),
    'preload = ["./coverage-preload.mjs"]\n[test]\npreload = ["./coverage-test-preload.mjs"]\n',
  )
  // Istanbul visits the original TS/TSX syntax and retains original coordinates.
  // Bun still handles type erasure, JSX, SQLite, HTTP and browser asset compilation.
  const instrumenter = createInstrumenter({
    esModules: true,
    compact: false,
    preserveComments: true,
    coverageGlobalScope: 'globalThis',
    coverageGlobalScopeFunc: false,
    parserPlugins: [
      'typescript',
      'jsx',
      'explicitResourceManagement',
      'importAttributes',
    ],
  })
  for (const path of files) {
    const source = await readFile(join(temp, path), 'utf8')
    const compiled = instrumenter.instrumentSync(source, path)
    const initial = instrumenter.lastFileCoverage()
    if (!initial || initial.path !== path)
      throw new Error('Uninstrumented production file: ' + path)
    seed[path] = initial
    originals.set(path, source)
    await writeFile(join(temp, path), compiled)
  }
  // Hook registration belongs to the file's e2e collection scope, which changes
  // between files even when they share a test worker and module cache.
  for await (const name of new Bun.Glob('**/*.e2e.ts').scan({
    cwd: join(temp, 'tests'),
  })) {
    const file = join(temp, 'tests', name)
    const helper = relative(
      dirname(file),
      join(temp, 'scripts/coverage/browser.mjs'),
    )
    const hooks =
      'import {beforeEach as __coverageBefore, afterEach as __coverageAfter} from "@e2e-dev/web";\n' +
      'import {startBrowserCoverage,finishBrowserCoverage} from ' +
      JSON.stringify(helper) +
      ';\n' +
      '__coverageBefore(async ({browser}) => { await startBrowserCoverage(browser) });\n' +
      '__coverageAfter(async ({browser}) => { await finishBrowserCoverage(browser,' +
      JSON.stringify(raw) +
      ') });\n'
    await writeFile(file, hooks + (await readFile(file, 'utf8')))
  }
}

async function report(nativeOnly = false) {
  const collector = createCollector(seed)
  const map = collector.map
  const checkpointOnly = {}
  let completedNativeRunners = 0
  const observed = new Set(),
    browserFiles = new Set(),
    sources = {}
  for (const name of await readdir(raw)) {
    if (!name.endsWith('.json')) continue
    const kind = name.split('-')[0]
    const {
      complete,
      nativeTestRunner,
      files: record,
    } = JSON.parse(await readFile(join(raw, name), 'utf8'))
    if (nativeTestRunner && complete) completedNativeRunners++
    if (!complete) checkpointOnly[kind] = (checkpointOnly[kind] || 0) + 1
    sources[kind] = (sources[kind] || 0) + 1
    for (const [path, counts] of Object.entries(record)) {
      collector.add(path, counts, name)
      observed.add(path)
      if (kind === 'browser') browserFiles.add(path)
    }
  }
  await mkdir(output, { recursive: true })
  const context = createContext({
    dir: nativeOnly ? join(output, 'native') : output,
    coverageMap: map,
    sourceFinder(path) {
      const source = originals.get(path)
      if (source === undefined)
        throw new Error('Unknown original source: ' + path)
      return source
    },
  })
  if (nativeOnly) {
    reports.create('json-summary').execute(context)
    const { lines, branches } = map.getCoverageSummary()
    console.log(
      `Native Istanbul coverage: ${lines.covered}/${lines.total} lines (${lines.pct}%), ${branches.covered}/${branches.total} branches (${branches.pct}%).`,
    )
    return 0
  }
  for (const type of ['lcovonly', 'json', 'json-summary', 'html'])
    reports.create(type).execute(context)
  const missing = []
  const criticalGaps = {}
  for (const path of files) {
    const file = map.fileCoverageFor(path)
    const summary = file.toSummary()
    if (
      (summary.statements.total ||
        summary.functions.total ||
        summary.branches.total) &&
      !observed.has(path)
    )
      missing.push(path)
    if (
      critical.test(path) &&
      (summary.lines.covered < summary.lines.total ||
        summary.branches.covered < summary.branches.total)
    ) {
      criticalGaps[path] = {
        lines: summary.lines.total - summary.lines.covered,
        branches: summary.branches.total - summary.branches.covered,
      }
      console.warn(
        `${path}: critical lines ${summary.lines.covered}/${summary.lines.total}, branches ${summary.branches.covered}/${summary.branches.total} (target 100%).`,
      )
    }
    if (
      (path.startsWith('public/') ||
        /\/ui\/(?:hydrate-login\.ts|login-client\.tsx)$/.test(path)) &&
      !browserFiles.has(path)
    )
      missing.push('browser: ' + path)
  }
  for (const kind of ['bun', 'server', 'browser'])
    if (!sources[kind]) missing.push('observation kind: ' + kind)
  if (!completedNativeRunners) missing.push('completed native test runner')
  const browserReport = Bun.file(join(temp, '.e2e/report.json'))
  let browserRun
  if (await browserReport.exists()) {
    const { run } = await browserReport.json()
    browserRun = {
      id: run.id,
      status: run.status,
      durationMs: run.durationMs,
      summary: run.summary,
      failed: run.results
        .filter((result) => result.selected && result.status === 'failed')
        .map((result) => ({ file: result.file, title: result.titlePath })),
    }
    if (!run.summary.executed) missing.push('browser test execution')
  } else missing.push('browser run report')
  const { lines, branches } = map.getCoverageSummary()
  console.log(
    `Combined Istanbul coverage: ${lines.covered}/${lines.total} lines (${lines.pct}%), ${branches.covered}/${branches.total} branches (${branches.pct}%), ${files.length} source files.`,
  )
  console.log('Observation sets:', JSON.stringify(sources))
  if (missing.length)
    console.error('Missing execution evidence:', missing.join(', '))
  if (runFailures.length)
    console.error('Failed coverage suite:', runFailures.join(', '))
  const passed =
    !runFailures.length &&
    !missing.length &&
    lines.total > 0 &&
    lines.covered / lines.total >= 0.9 &&
    branches.total > 0 &&
    branches.covered / branches.total >= 0.85
  await writeFile(
    evidence,
    JSON.stringify(
      {
        status: 'complete',
        passed,
        criticalTargetMet: Object.keys(criticalGaps).length === 0,
        criticalGaps,
        bunVersion: Bun.version,
        deterministicBrowserOnly:
          process.env.FILESERVER_COVERAGE_DETERMINISTIC === '1',
        sourceSha256: Object.fromEntries(
          [...originals].map(([path, source]) => [path, digest(source)]),
        ),
        testInputSha256: testInputs,
        sources,
        checkpointOnly,
        completedNativeRunners,
        browserRun,
        observed: [...observed].sort(),
        browserFiles: [...browserFiles].sort(),
        missing,
        runFailures,
      },
      null,
      2,
    ),
  )
  return passed ? 0 : 1
}

try {
  await mkdir(output, { recursive: true })
  await writeFile(evidence, JSON.stringify({ status: 'collecting' }))
  await stage()
  await execute('Bun', ['test', 'tests', 'scripts'])
  await report(true)
  const browserArgs = ['scripts/e2e.ts']
  if (process.env.FILESERVER_COVERAGE_DETERMINISTIC === '1')
    browserArgs.push('--exclude-tag', 'agent')
  await execute('Chromium', browserArgs)
  process.exitCode = await report()
} catch (error) {
  await writeFile(
    evidence,
    JSON.stringify({ status: 'failed', error: String(error) }),
  )
  throw error
} finally {
  await rm(temp, { recursive: true, force: true })
}
