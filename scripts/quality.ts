import { readFile, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { calculateMetrics } from 'mutation-testing-metrics'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

const critical =
  /^(?:server\.ts$|app\/(application|config|filesystem|http|identity|inspection|metadata|operations|proxy|router|runtime|security|shares|transfers|transport)(?:\/|\.))/
const production = /^(app\/.*\.[cm]?[jt]sx?|public\/.*\.[cm]?js|server\.ts)$/

async function sourceFiles() {
  const files = ['server.ts']
  for (const folder of ['app', 'public']) {
    for await (const entry of new Bun.Glob('**/*').scan({
      cwd: folder,
      onlyFiles: true,
    })) {
      const path = folder + '/' + entry
      if (production.test(path) && !path.endsWith('.d.ts')) files.push(path)
    }
  }
  return files.sort()
}

async function command(args: string[], env = process.env) {
  const child = Bun.spawn(args, {
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return await child.exited
}

function assertDependencies() {
  const pkg: { dependencies?: Record<string, string> } = JSON.parse(
    readFileSync('package.json', 'utf8'),
  )
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    if (
      !['remix', 'effect', '@remix-run/ui'].includes(name) ||
      !/^\d+\.\d+\.\d+$/.test(version)
    ) {
      throw new Error(
        `Unapproved or unpinned production dependency: ${name} ${version}`,
      )
    }
  }
}

// A synchronous rejection handler is the end of a Promise chain at an event boundary.
function handledRejection(expression: ts.Expression, checker: ts.TypeChecker) {
  if (
    !ts.isCallExpression(expression) ||
    !ts.isPropertyAccessExpression(expression.expression)
  )
    return false
  const method = expression.expression.name.text
  const handler =
    method === 'catch'
      ? expression.arguments[0]
      : method === 'then'
        ? expression.arguments[1]
        : undefined
  if (!handler) return false
  if (
    (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
    ts.isBlock(handler.body) &&
    !handler.body.statements.length
  )
    return false
  const signatures = checker.getTypeAtLocation(handler).getCallSignatures()
  return (
    signatures.length > 0 &&
    signatures.every(
      (signature) => !signature.getReturnType().getProperty('then'),
    )
  )
}

async function lint() {
  assertDependencies()
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile)
  if (config.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
    )
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, '.')
  const files = await sourceFiles()
  const program = ts.createProgram(
    [...new Set([...parsed.fileNames, ...files])],
    { ...parsed.options, allowJs: true },
  )
  const checker = program.getTypeChecker()
  const paths = new Set(files.map((file) => resolve(file)))
  const edges = new Map<string, Set<string>>()
  const issues: string[] = []
  for (const file of files) {
    const src = program.getSourceFile(file)
    if (!src) throw new Error('Could not parse ' + file)
    const dependencies = new Set<string>()
    edges.set(resolve(file), dependencies)
    const report = (node: ts.Node, message: string) => {
      const line =
        src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1
      issues.push(`${file}:${line} ${message}`)
    }
    const text = src.text
    for (const match of text.matchAll(
      /^[ \t]*(?:\/\/|\/\*|\*)\s*@ts-(?:ignore|nocheck)\b/gm,
    )) {
      issues.push(
        `${file}:${src.getLineAndCharacterOfPosition(match.index).line + 1} suppressed TypeScript diagnostic`,
      )
    }
    function walk(node: ts.Node) {
      if (node.kind === ts.SyntaxKind.AnyKeyword) report(node, 'explicit any')
      if (
        ts.isNonNullExpression(node) &&
        !/invariant/i.test(
          node.getFullText(src).slice(0, node.getLeadingTriviaWidth(src)),
        )
      ) {
        report(node, 'non-null assertion needs a documented invariant')
      }
      if (ts.isCatchClause(node) && node.block.statements.length === 0)
        report(node, 'empty catch')
      if (ts.isExpressionStatement(node)) {
        const expression = ts.isVoidExpression(node.expression)
          ? node.expression.expression
          : node.expression
        const type = checker.getTypeAtLocation(expression)
        const stored =
          ts.isBinaryExpression(expression) &&
          [
            ts.SyntaxKind.EqualsToken,
            ts.SyntaxKind.QuestionQuestionEqualsToken,
            ts.SyntaxKind.AmpersandAmpersandEqualsToken,
            ts.SyntaxKind.BarBarEqualsToken,
          ].includes(expression.operatorToken.kind)
        if (
          !stored &&
          type.getProperty('then') &&
          !handledRejection(expression, checker)
        ) {
          report(node, 'unobserved Promise result')
        }
      }
      let specifier: ts.Expression | undefined
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly)
        specifier = node.moduleSpecifier
      if (ts.isExportDeclaration(node) && !node.isTypeOnly)
        specifier = node.moduleSpecifier
      if (
        specifier &&
        ts.isStringLiteral(specifier) &&
        specifier.text.startsWith('.')
      ) {
        const mod = ts.resolveModuleName(
          specifier.text,
          resolve(file),
          program.getCompilerOptions(),
          ts.sys,
        ).resolvedModule
        if (mod && paths.has(resolve(mod.resolvedFileName)))
          dependencies.add(resolve(mod.resolvedFileName))
      }
      ts.forEachChild(node, walk)
    }
    walk(src)
  }
  const seen = new Set<string>()
  const active = new Set<string>()
  function visit(file: string, chain: string[]) {
    if (active.has(file)) {
      issues.push(
        'Import cycle: ' +
          [...chain.slice(chain.indexOf(file)), file]
            .map((path) => relative('.', path))
            .join(' -> '),
      )
      return
    }
    if (seen.has(file)) return
    seen.add(file)
    active.add(file)
    for (const next of edges.get(file) ?? []) visit(next, [...chain, file])
    active.delete(file)
  }
  for (const file of edges.keys()) visit(file, [])
  for (const issue of issues) console.error(issue)
  console.log(
    `Checked ${files.length} production modules, ${issues.length} lint finding(s).`,
  )
  return issues.length ? 1 : 0
}

async function coverage() {
  const report = '.quality/coverage/lcov.info'
  await rm(report, { force: true })
  const run = await command([
    'bun',
    'test',
    '--coverage',
    '--coverage-reporter=lcov',
    '--coverage-dir=.quality/coverage',
  ])
  if (run !== 0) return run
  const records = (await readFile(report, 'utf8')).split('end_of_record')
  const included = new Set<string>()
  let lines = 0,
    hits = 0,
    branches = 0,
    coveredBranches = 0
  for (const record of records) {
    const raw = /^SF:(.+)$/m.exec(record)?.[1]
    if (!raw) continue
    const path = relative(process.cwd(), resolve(raw.trim()))
    if (!production.test(path)) continue
    included.add(path)
    let fileMissed = 0
    for (const hit of record.matchAll(/^DA:\d+,(\d+)/gm)) {
      lines++
      if (Number(hit[1])) hits++
      else fileMissed++
    }
    for (const b of record.matchAll(/^BRDA:\d+,[^,]+,[^,]+,(-|\d+)/gm)) {
      branches++
      if (Number(b[1]) > 0) coveredBranches++
    }
    if (critical.test(path) && fileMissed)
      console.warn(
        `${path}: ${fileMissed} uncovered critical lines (target 100%).`,
      )
  }
  // Omitted modules never count as covered. Type-only modules emit empty JavaScript.
  const missing: string[] = []
  for (const file of await sourceFiles()) {
    if (included.has(file)) continue
    const code = await readFile(file, 'utf8')
    const js = ts
      .transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          jsx: ts.JsxEmit.Preserve,
          removeComments: true,
          module: ts.ModuleKind.ESNext,
        },
      })
      .outputText.trim()
    if (js && js !== 'export {};') missing.push(file)
  }
  if (missing.length)
    console.error('Executable files absent from LCOV: ' + missing.join(', '))
  console.log(`Covered production lines: ${hits}/${lines} (minimum 90%).`)
  if (branches)
    console.log(
      `Covered branches: ${coveredBranches}/${branches} (minimum 85%).`,
    )
  else
    console.error(
      'Branch coverage unavailable: this Bun LCOV report contains no branch counters. The 85% gate is unverified.',
    )
  return missing.length ||
    !lines ||
    hits / lines < 0.9 ||
    !branches ||
    coveredBranches / branches < 0.85
    ? 1
    : 0
}

function gitPaths(args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { stderr: 'pipe' })
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString().trim() || 'Git lookup failed')
  return result.stdout.toString().split('\0').filter(Boolean)
}

interface MutationReport {
  config: { mutate: string[] }
  files: Parameters<typeof calculateMetrics>[0]
}

async function mutationFiles(all: boolean) {
  const sources = await sourceFiles()
  if (all) return sources
  const base = process.env.MUTATION_BASE || 'HEAD'
  const changes = new Set([
    ...gitPaths([
      'diff',
      '--name-only',
      '-z',
      '--diff-filter=ACMR',
      base,
      '--',
    ]),
    ...gitPaths(['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  return sources.filter((file) => changes.has(file))
}

// Each source belongs to exactly one shard. Balancing by size keeps larger modules apart.
async function mutationMatrix(all: boolean) {
  const files = await mutationFiles(all)
  const sizes = await Promise.all(
    files.map(async (file) => ({ file, size: (await stat(file)).size })),
  )
  const shards = Array.from(
    { length: Math.min(12, Math.max(1, sizes.length)) },
    (_, index) => ({
      index,
      files: [] as string[],
      size: 0,
    }),
  )
  for (const source of sizes.sort((a, b) => b.size - a.size)) {
    const lightest = shards.reduce((a, b) => (a.size <= b.size ? a : b))
    lightest.files.push(source.file)
    lightest.size += source.size
  }
  return { include: shards.map(({ index, files }) => ({ index, files })) }
}

function reviewMutation(files: MutationReport['files']) {
  let survivors = 0
  for (const [file, { mutants }] of Object.entries(files)) {
    if (!critical.test(file)) continue
    for (const mutant of mutants) {
      if (mutant.status !== 'Survived' && mutant.status !== 'NoCoverage')
        continue
      console.error(
        `${file}:${mutant.location.start.line} #${mutant.id} ${mutant.mutatorName} ${mutant.status}; review required.`,
      )
      survivors++
    }
  }
  const metrics = calculateMetrics(files).metrics
  console.log(
    `Mutation score: ${metrics.totalDetected}/${metrics.totalValid} detected, ${metrics.mutationScore.toFixed(2)}%. Pending: ${metrics.pending}. Critical mutants requiring review: ${survivors}.`,
  )
  return metrics.pending || survivors || metrics.mutationScore < 85 ? 1 : 0
}

async function mutation(all: boolean) {
  const selected = await mutationFiles(all)
  if (!selected.length) {
    console.log('No changed production modules to mutate.')
    return 0
  }
  const directory = process.env.FILESERVER_MUTATION_REPORTS
  if (directory) {
    const wanted = new Set(selected)
    const combined: MutationReport['files'] = {}
    for await (const name of new Bun.Glob('**/report.json').scan({
      cwd: directory,
      absolute: true,
    })) {
      const report: MutationReport = JSON.parse(await readFile(name, 'utf8'))
      for (const file of report.config.mutate) {
        if (!wanted.delete(file))
          throw new Error('Unexpected or repeated mutation input: ' + file)
      }
      for (const [file, entry] of Object.entries(report.files)) {
        if (
          !report.config.mutate.includes(file) ||
          entry.source !== (await readFile(file, 'utf8'))
        )
          throw new Error('Mutation report source mismatch: ' + file)
        combined[file] = entry
      }
    }
    if (wanted.size)
      throw new Error('Missing mutation shards for: ' + [...wanted].join(', '))
    return reviewMutation(combined)
  }
  const report = '.quality/mutation/report.json'
  await rm(report, { force: true })
  const result = await runStryker(selected)
  if (!(await Bun.file(report).exists())) return result || 1
  const data: MutationReport = JSON.parse(await readFile(report, 'utf8'))
  return reviewMutation(data.files) || result
}

async function runStryker(files: string[], shard = false) {
  // The command runner exposes the whole suite as one test. A changed assertion,
  // dependency or collaborating module must invalidate a cached kill.
  const hash = createHash('sha256')
    .update(Bun.version)
    .update(JSON.stringify(files))
  const inputs = ['server.ts', 'bun.lock', 'package.json', 'tsconfig.json']
  for (const directory of ['app', 'public', 'scripts', 'tests']) {
    for await (const path of new Bun.Glob('**/*').scan({
      cwd: directory,
      onlyFiles: true,
    }))
      inputs.push(directory + '/' + path)
  }
  for (const path of inputs.sort())
    hash
      .update(path + '\0')
      .update(await readFile(path))
      .update('\0')
  const incremental =
    '.quality/mutation/incremental-' + hash.digest('hex') + '.json'
  return await command(
    [
      'node',
      'node_modules/@stryker-mutator/core/bin/stryker.js',
      'run',
      'scripts/stryker.config.mjs',
    ],
    {
      ...process.env,
      FILESERVER_MUTATION_FILES: JSON.stringify(files),
      FILESERVER_MUTATION_INCREMENTAL: incremental,
      FILESERVER_MUTATION_SHARD: shard ? '1' : '0',
    },
  )
}

async function quality(release: boolean) {
  const gates = [
    'format:check',
    'typecheck',
    'effect:check',
    'effect:editor',
    'lint',
    'coverage',
    'audit',
  ]
  let failed = false
  for (const gate of gates) {
    const status = await command(['bun', 'run', gate])
    if (status !== 0) failed = true
  }
  if (release) {
    if (
      (await command(['bun', 'test', 'tests/transfers-large.test.ts'], {
        ...process.env,
        FILESERVER_LARGE_RANGE: '1',
      })) !== 0
    )
      failed = true
    for (const gate of [
      'test:security',
      'test:integration',
      'test:performance',
      'test:e2e:fixture',
    ]) {
      if ((await command(['bun', 'run', gate])) !== 0) failed = true
    }
  }
  // Stryker checks its own baseline and aborts on a red suite; retain its report independently.
  if ((await mutation(release)) !== 0) failed = true
  return failed ? 1 : 0
}

switch (Bun.argv[2]) {
  case 'lint':
    process.exitCode = await lint()
    break
  case 'coverage':
    process.exitCode = await coverage()
    break
  case 'mutation-matrix':
    console.log(JSON.stringify(await mutationMatrix(Bun.argv[3] === 'all')))
    break
  case 'mutation-shard': {
    const index = Number(Bun.argv[3])
    const plan = await mutationMatrix(Bun.argv[4] === 'all')
    const shard = plan.include[index]
    if (!shard) throw new Error('Invalid mutation shard index.')
    process.exitCode = shard.files.length
      ? await runStryker(shard.files, true)
      : 0
    break
  }
  case 'mutation':
    process.exitCode = await mutation(false)
    break
  case 'mutation-all':
    process.exitCode = await mutation(true)
    break
  case 'quality':
    process.exitCode = await quality(false)
    break
  case 'release':
    process.exitCode = await quality(true)
    break
  default:
    throw new Error(
      'Choose lint, coverage, mutation, mutation-all, quality or release.',
    )
}
