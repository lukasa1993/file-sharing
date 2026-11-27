// Stryker's bundled command runner sets the active mutation in the Bun test child's environment.
const selected = process.env.FILESERVER_MUTATION_FILES
export default {
  testRunner: 'command',
  commandRunner: {
    command: "bun test --path-ignore-patterns='**/performance/**'",
  },
  mutate: selected
    ? JSON.parse(selected)
    : ['app/**/*.{ts,tsx}', 'server.ts', 'public/**/*.js'],
  coverageAnalysis: 'off',
  incremental: true,
  incrementalFile:
    process.env.FILESERVER_MUTATION_INCREMENTAL ||
    '.quality/mutation/incremental.json',
  tempDirName: '.stryker-tmp',
  ignorePatterns: [
    '.quality/**',
    '.e2e/**',
    '.git/**',
    '.agents/**',
    '.claude/**',
    'node_modules/**',
  ],
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: '.quality/mutation/report.json' },
  thresholds: {
    high: 100,
    low: 85,
    break: process.env.FILESERVER_MUTATION_SHARD === '1' ? null : 85,
  },
  concurrency: 2,
  timeoutMS: 15000,
  disableTypeChecks: false,
}
