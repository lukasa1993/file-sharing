import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const requireFromProject = createRequire(join(root, 'package.json'))
const fixture = mkdtempSync(join(tmpdir(), 'fileserver-effect-editor-'))

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function editorDiagnostics(commands: string) {
  const server = spawn(
    'node',
    [
      requireFromProject.resolve('typescript/lib/tsserver.js'),
      '--allowLocalPluginLoads',
      '--disableAutomaticTypingAcquisition',
    ],
    { cwd: fixture, stdio: ['pipe', 'pipe', 'inherit'] },
  )
  const timeout = setTimeout(() => server.kill(), 90_000)
  const lines = createInterface({ input: server.stdout })
  const results = new Map<number, unknown[]>()
  try {
    server.stdin.write(commands + '\n')
    for await (const line of lines) {
      if (!line.startsWith('{')) continue
      const message: unknown = JSON.parse(line)
      if (
        !record(message) ||
        message.type !== 'response' ||
        message.command !== 'semanticDiagnosticsSync'
      )
        continue
      if (
        !message.success ||
        !Array.isArray(message.body) ||
        typeof message.request_seq !== 'number'
      )
        throw new Error(
          'Workspace tsserver did not return semantic diagnostics: ' +
            JSON.stringify(message),
        )
      results.set(message.request_seq, message.body)
      if (results.size === 2) return results
    }
    throw new Error(
      'Workspace tsserver stopped before both diagnostic requests completed.',
    )
  } finally {
    clearTimeout(timeout)
    lines.close()
    server.stdin.end()
    server.kill()
  }
}

function isFloatingDiagnostic(value: unknown) {
  return (
    record(value) &&
    value.category === 'error' &&
    typeof value.text === 'string' &&
    (value.text.includes('floatingEffect') ||
      /Effect.*neither yielded nor (used|assigned)/i.test(value.text))
  )
}

try {
  const bad = join(fixture, 'floating.ts')
  const good = join(fixture, 'owned.ts')
  symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir')
  writeFileSync(
    join(fixture, 'tsconfig.json'),
    JSON.stringify({
      extends: join(root, 'tsconfig.json'),
      include: ['*.ts'],
    }),
  )
  writeFileSync(
    bad,
    "import { Effect } from 'effect';\nEffect.log('editor fixture');\n",
  )
  writeFileSync(
    good,
    "import { Effect } from 'effect';\nexport const log = Effect.log('editor fixture');\n",
  )
  const commands = [
    { command: 'open', arguments: { file: bad, projectRootPath: fixture } },
    { command: 'open', arguments: { file: good, projectRootPath: fixture } },
    { command: 'semanticDiagnosticsSync', arguments: { file: bad } },
    { command: 'semanticDiagnosticsSync', arguments: { file: good } },
  ]
    .map((request, i) =>
      JSON.stringify({ seq: i + 1, type: 'request', ...request }),
    )
    .join('\n')
  const results = await editorDiagnostics(commands)
  const floating = results.get(3)
  const clean = results.get(4)
  if (!clean || !floating)
    throw new Error('Missing diagnostic response for an editor fixture.')
  if (!floating.some(isFloatingDiagnostic)) {
    throw new Error(
      'Editor quality gate failed. The workspace tsserver and configured Effect plugin missed a floating Effect: ' +
        JSON.stringify(floating),
    )
  }
  if (clean.some((d) => record(d) && d.category === 'error')) {
    throw new Error(
      'Editor quality gate failed. The valid Effect fixture produced an error: ' +
        JSON.stringify(clean),
    )
  }
  console.log(
    'Workspace editor diagnostics detected the floating Effect and accepted the assigned Effect.',
  )
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
