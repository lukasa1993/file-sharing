import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative } from 'node:path'
import { declareClassPlugin, PluginKind } from '@stryker-mutator/api/plugin'

// Stryker's final JSON is authoritative. Keep a separate journal of finished
// candidates and a plan so an interrupted full run remains inspectable.
class MutationProgress {
  base =
    process.env.FILESERVER_MUTATION_INCREMENTAL ||
    '.quality/mutation/incremental.json'
  run = crypto.randomUUID()
  profiles = []
  constructor() {
    mkdirSync(dirname(this.base), { recursive: true })
  }
  onDryRunCompleted({ result }) {
    this.profiles = result.tests.map((test) => ({
      id: test.id,
      durationMs: test.timeSpentMs,
      coveredSites: Object.keys(result.mutantCoverage?.perTest[test.id] ?? {})
        .length,
    }))
  }
  onMutationTestingPlanReady({ mutantPlans }) {
    const totals = {}
    // Stryker omits files that have no generated mutations from its final JSON.
    // Record the original plan independently to distinguish those from missing data.
    const selected =
      process.env.FILESERVER_MUTATION_SHARD === undefined
        ? []
        : JSON.parse(process.env.FILESERVER_MUTATION_FILES)
    const inputs = Object.fromEntries(
      selected.map((file) => [
        file,
        {
          sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
          ids: [],
        },
      ]),
    )
    let possibleSuiteExecutions = 0
    let allCoveringSuiteMs = 0
    for (const item of mutantPlans) {
      if (selected.length)
        inputs[relative(process.cwd(), item.mutant.fileName)].ids.push(
          item.mutant.id,
        )
      const key =
        item.plan === 'Run'
          ? item.runOptions.testFilter?.length === 0
            ? 'NoCoverage'
            : 'scheduled'
          : item.mutant.status
      totals[key] = (totals[key] || 0) + 1
      if (item.plan === 'Run') {
        possibleSuiteExecutions +=
          item.runOptions.testFilter?.length ?? this.profiles.length
        allCoveringSuiteMs += item.netTime
      }
    }
    if (selected.length)
      writeFileSync('.quality/mutation/manifest.json', JSON.stringify(inputs), {
        mode: 0o600,
      })
    writeFileSync(
      this.base + '.plan.json',
      JSON.stringify(
        {
          run: this.run,
          started: new Date().toISOString(),
          total: mutantPlans.length,
          totals,
          possibleSuiteExecutions,
          allCoveringSuiteMs,
          suites: this.profiles,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
  }
  onMutantTested(result) {
    const {
      id,
      fileName,
      mutatorName,
      location,
      status,
      replacement,
      killedBy,
    } = result
    appendFileSync(
      this.base + '.ndjson',
      JSON.stringify({
        run: this.run,
        at: new Date().toISOString(),
        id,
        file: relative(process.cwd(), fileName),
        mutatorName,
        location,
        replacement,
        status,
        killedBy,
      }) + '\n',
      { mode: 0o600 },
    )
  }
}
export const strykerPlugins = [
  declareClassPlugin(PluginKind.Reporter, 'lshare-progress', MutationProgress),
]
