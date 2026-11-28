import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { calculateMetrics } from 'mutation-testing-metrics'
import {
  critical,
  qualityFiles,
  qualityDirectories,
} from '../quality-sources.ts'

export interface MutationReport {
  config: { mutate: string[] }
  files: Parameters<typeof calculateMetrics>[0]
}

export async function mutationFingerprint(files: string[]) {
  // A changed assertion, dependency, fixture, or collaborating module
  // must invalidate cached kills and their coverage-based test selections.
  const node = Bun.spawnSync(['node', '--version'])
  if (node.exitCode !== 0) throw new Error('Node is required for Stryker.')
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        Bun.version,
        node.stdout.toString().trim(),
        process.platform,
        process.arch,
        process.env.E2E_BROWSER || 'chromium',
      ]),
    )
    .update(JSON.stringify(files))
  const inputs = [...qualityFiles]
  for (const directory of qualityDirectories) {
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
  return hash.digest('hex')
}

export async function readVerifiedMutation(
  reportFile: string,
  wanted: Set<string>,
) {
  const report: MutationReport = JSON.parse(await readFile(reportFile, 'utf8'))
  const manifest: {
    fingerprint: string
    modules: Record<string, { sha256: string; ids: string[] }>
  } = JSON.parse(
    await readFile(join(dirname(reportFile), 'manifest.json'), 'utf8'),
  )
  if (
    manifest.fingerprint !== (await mutationFingerprint(report.config.mutate))
  )
    throw new Error(
      'Mutation test, source, tool or configuration fingerprint mismatch.',
    )
  const inputs = new Set(report.config.mutate)
  if (
    Object.keys(report.files).some((file) => !inputs.has(file)) ||
    Object.keys(manifest.modules).some((file) => !inputs.has(file))
  )
    throw new Error('Mutation report contains unexpected sources.')
  for (const file of report.config.mutate) {
    if (!wanted.delete(file))
      throw new Error('Unexpected or repeated mutation input: ' + file)
    const source = await readFile(file)
    const expected = manifest.modules[file]
    const entry = report.files[file]
    if (
      !expected ||
      expected.sha256 !== createHash('sha256').update(source).digest('hex') ||
      (entry && entry.source !== source.toString())
    )
      throw new Error('Mutation report source mismatch: ' + file)
    const actual = new Set(entry?.mutants.map((mutant) => mutant.id) ?? [])
    if (
      actual.size !== expected.ids.length ||
      actual.size !== (entry?.mutants.length ?? 0) ||
      expected.ids.some((id) => !actual.delete(id))
    )
      throw new Error('Incomplete or repeated mutation result: ' + file)
  }
  return report.files
}

export function reviewMutation(files: MutationReport['files']) {
  let survivors = 0
  for (const [file, { mutants }] of Object.entries(files)) {
    for (const mutant of mutants) {
      if (
        mutant.status === 'RuntimeError' ||
        mutant.status === 'CompileError'
      ) {
        console.error(
          file +
            ':' +
            mutant.location.start.line +
            ' #' +
            mutant.id +
            ' ' +
            mutant.status,
        )
        continue
      }
      if (!critical.test(file)) continue
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
    `Mutation score: ${metrics.totalDetected}/${metrics.totalValid} detected, ${metrics.mutationScore.toFixed(2)}%. Killed: ${metrics.killed}. Timed out: ${metrics.timeout}. Pending: ${metrics.pending}. Runtime errors: ${metrics.runtimeErrors}. Compile errors: ${metrics.compileErrors}. Critical mutants requiring review: ${survivors}.`,
  )
  return metrics.pending ||
    metrics.runtimeErrors ||
    metrics.compileErrors ||
    survivors ||
    metrics.mutationScore < 85
    ? 1
    : 0
}
