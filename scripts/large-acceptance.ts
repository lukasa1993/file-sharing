import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import {
  defaultBytes,
  runLargeAcceptance,
} from '../tests/performance/large-acceptance.ts'

try {
  const { values } = parseArgs({
    options: {
      directory: { type: 'string', default: tmpdir() },
      'receiver-directory': { type: 'string' },
      bytes: { type: 'string', default: String(defaultBytes) },
      'sparse-download': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    console.log(
      'bun scripts/large-acceptance.ts [--directory SCRATCH] [--receiver-directory SCRATCH] [--bytes COUNT] [--sparse-download]',
    )
    console.log(
      'Linux, Bun. Defaults to a 101 GiB randomized upload, process restart, download interruption and complete digest verification under disposable scratch directories. The allocated run needs room for two payloads plus reserve. Sparse download seeds four regions and verifies every byte delivered over HTTP without saving the receiver file.',
    )
  } else {
    const cancel = new AbortController()
    const stop = () => cancel.abort(new Error('Acceptance interrupted'))
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    let last = 0
    try {
      const report = await runLargeAcceptance({
        directory: values.directory,
        ...(values['receiver-directory']
          ? { receiverDirectory: values['receiver-directory'] }
          : {}),
        bytes: Number(values.bytes),
        mode: values['sparse-download'] ? 'sparse-download' : 'allocated',
        signal: AbortSignal.any([
          cancel.signal,
          AbortSignal.timeout(6 * 3600000),
        ]),
        progress(phase, bytes) {
          if (!bytes || Date.now() - last > 10000) {
            console.error(
              JSON.stringify({ phase, bytes, time: new Date().toISOString() }),
            )
            last = Date.now()
          }
        },
      })
      console.log(JSON.stringify(report, null, 2))
    } finally {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Acceptance failed')
  process.exitCode = 1
}
