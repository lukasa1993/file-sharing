import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { copyFile, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { initialize } from './ops'
import { addCopyStorage } from '../tests/fixtures/copy-storage.ts'
import { configureFixtureIssuer } from '../tests/fixtures/oidc.ts'
import { buildDistribution } from './build.ts'
import type { Subprocess } from 'bun'

async function availablePort() {
  const socket = createServer()
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', resolve)
  })
  const address = socket.address()
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  )
  if (!address || typeof address === 'string')
    throw new Error('Could not reserve a loopback port.')
  return address.port
}

async function waitUntilReady(
  origin: string,
  server: Subprocess,
  signal: AbortSignal,
) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    if (server.exitCode !== null)
      throw new Error(`Fixture server exited with status ${server.exitCode}.`)
    try {
      const response = await fetch(origin + '/readyz', {
        redirect: 'error',
        signal: AbortSignal.timeout(1000),
      })
      await response.body?.cancel()
      if (response.status === 200) return
    } catch {
      // Refused connections are expected until the listener opens.
      signal.throwIfAborted()
    }
    await delay(150, undefined, { signal })
  }
  throw new Error('Fixture server did not become ready within 45 seconds.')
}

async function shutDown(child?: Subprocess) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const timeout = setTimeout(() => child.kill('SIGKILL'), 6000)
  try {
    await child.exited
  } finally {
    clearTimeout(timeout)
  }
}

const temp = await mkdtemp(join(tmpdir(), 'fileserver-e2e-'))
const state = join(temp, 'state')
const args = Bun.argv.slice(2)
const packaged = args.includes('--packaged')
const externalIdentity = !args.includes('--local-auth-only')
const runnerArgs = args.filter(
  (arg) => arg !== '--packaged' && arg !== '--local-auth-only',
)
const abort = new AbortController()
let idp: Awaited<ReturnType<typeof configureFixtureIssuer>> | undefined
let server: Subprocess | undefined
let runner: Subprocess | undefined
function interrupt() {
  abort.abort()
  runner?.kill('SIGTERM')
}
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)

try {
  const username = 'e2e-owner'
  const password = randomBytes(32).toString('base64url')
  await initialize(state, username, { password, mountId: 'e2e' })
  await addCopyStorage(state, true)
  await copyFile(
    new URL('../tests/fixtures/handoff.txt', import.meta.url),
    join(state, 'storage', 'handoff.txt'),
  )
  const root = fileURLToPath(new URL('../', import.meta.url))
  const port = await availablePort()
  const origin = `http://127.0.0.1:${port}`
  const config = join(state, 'config')
  if (externalIdentity)
    idp = await configureFixtureIssuer(config, origin, username)
  if (packaged) {
    await buildDistribution(join(temp, 'dist'))
    // Only shipped server and browser assets are available from this directory.
    await symlink(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir')
  }
  const entry = packaged ? 'dist/app/server.js' : 'server.ts'
  server = Bun.spawn([process.execPath, 'run', entry], {
    cwd: packaged ? temp : root,
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      PATH: process.env.PATH,
      NODE_ENV: packaged ? 'production' : 'test',
      PUBLIC_ORIGIN: origin,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: join(state, 'data'),
      CONFIG_FILE: join(config, 'mounts.json'),
      SESSION_SECRET_FILE: join(config, 'session.key'),
      BOOTSTRAP_FILE: join(config, 'bootstrap.json'),
    },
  })
  await waitUntilReady(origin, server, abort.signal)
  const noProxy = [
    process.env.NO_PROXY ?? process.env.no_proxy,
    '127.0.0.1',
    'localhost',
    '::1',
  ]
    .filter(Boolean)
    .join(',')
  runner = Bun.spawn(
    ['node', 'node_modules/e2e/dist/cli/bin.js', 'run', ...runnerArgs],
    {
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
      env: {
        ...process.env,
        APP_URL: origin,
        E2E_FIXTURE_OIDC: externalIdentity ? '1' : '0',
        E2E_USER_OWNER_USERNAME: username,
        E2E_USER_OWNER_PASSWORD: password,
        E2E_SECRET_SHARE_PASSWORD: randomBytes(32).toString('base64url'),
        E2E_MEMBER_PASSWORD: randomBytes(32).toString('base64url'),
        E2E_REPLACEMENT_PASSWORD: randomBytes(32).toString('base64url'),
        NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? '1',
        NO_PROXY: noProxy,
        no_proxy: noProxy,
      },
    },
  )
  process.exitCode = await runner.exited
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Fixture setup failed.',
  )
  process.exitCode = 1
} finally {
  await shutDown(runner)
  await shutDown(server)
  await idp?.close()
  await rm(temp, { recursive: true, force: true })
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', interrupt)
}
