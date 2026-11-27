// Select native and browser suites using mutation coverage observed in a clean sandbox.
const selected = process.env.FILESERVER_MUTATION_FILES
export default {
  plugins: ['./scripts/mutation/runner.mjs', './scripts/mutation/progress.mjs'],
  testRunner: 'lshare-bun',
  dryRunTimeoutMinutes: 45,
  mutate: selected
    ? JSON.parse(selected)
    : [
        'app/**/*.{ts,tsx}',
        'shared/**/*.{ts,tsx}',
        'cloudflare/**/*.ts',
        '!cloudflare/browser/**',
        '!cloudflare/tests/**',
        '!cloudflare/e2e.config.ts',
        'cloudflare/assets/**/*.js',
        'server.ts',
        'public/**/*.js',
        'scripts/ops.ts',
        'scripts/storage-inventory.ts',
      ],
  coverageAnalysis: 'perTest',
  incremental: true,
  incrementalFile:
    process.env.FILESERVER_MUTATION_INCREMENTAL ||
    '.quality/mutation/incremental.json',
  tempDirName: '.stryker-tmp',
  ignorePatterns: [
    '.quality/**',
    '.e2e/**',
    'cloudflare/.e2e/**',
    '.cloudflare/**',
    '.wrangler/**',
    '.git/**',
    '.agents/**',
    '.claude/**',
    'node_modules/**',
  ],
  reporters: ['clear-text', 'json', 'lshare-progress'],
  jsonReporter: { fileName: '.quality/mutation/report.json' },
  thresholds: {
    high: 100,
    low: 85,
    break: process.env.FILESERVER_MUTATION_SHARD === '1' ? null : 85,
  },
  concurrency: 2,
  // Allow the browser to report its locator/assertion failure before Stryker
  // terminates the process group as a timeout.
  timeoutMS: 60000,
  disableTypeChecks: false,
}
