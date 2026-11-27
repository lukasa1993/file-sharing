import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { calculateMetrics } from 'mutation-testing-metrics'
import { critical } from '../quality-sources.ts'

export interface MutationReport {
  config: { mutate: string[] }
  files: Parameters<typeof calculateMetrics>[0]
}

export async function readVerifiedMutation(
  reportFile: string,
  wanted: Set<string>,
) {
  const report: MutationReport = JSON.parse(await readFile(reportFile, 'utf8'))
  const manifest: Record<string, { sha256: string; ids: string[] }> =
    JSON.parse(
      await readFile(join(dirname(reportFile), 'manifest.json'), 'utf8'),
    )
  const inputs = new Set(report.config.mutate)
  if (
    Object.keys(report.files).some((file) => !inputs.has(file)) ||
    Object.keys(manifest).some((file) => !inputs.has(file))
  )
    throw new Error('Mutation report contains unexpected sources.')
  for (const file of report.config.mutate) {
    if (!wanted.delete(file))
      throw new Error('Unexpected or repeated mutation input: ' + file)
    const source = await readFile(file)
    const expected = manifest[file]
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
