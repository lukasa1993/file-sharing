import { AwsClient } from 'aws4fetch'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { Subprocess } from 'bun'
import { stageCloudAssets } from './cloud-assets'

const root = fileURLToPath(new URL('../', import.meta.url))
const version = 'RELEASE.2025-09-07T16-13-09Z'
const architectures = {
  x64: [
    'amd64',
    '7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f',
  ],
  arm64: [
    'arm64',
    '5c83cd2cf151717ba0243f73e1c7802ff36e272b67144bdd7f1f7d684fd6f03d',
  ],
} as const

function readable(stream: ReadableStream<Uint8Array>) {
  async function* chunks() {
    const reader = stream.getReader()
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return
        yield chunk.value
      }
    } finally {
      reader.releaseLock()
    }
  }
  return Readable.from(chunks())
}

async function minioBinary() {
  if (process.env.MINIO_BINARY) return resolve(process.env.MINIO_BINARY)
  if (
    process.platform !== 'linux' ||
    (process.arch !== 'x64' && process.arch !== 'arm64')
  )
    throw new Error(
      'Set MINIO_BINARY to an installed MinIO server on this platform.',
    )
  const [arch, digest] = architectures[process.arch]
  const asset = 'minio.linux-' + arch + '.' + version
  const cache = process.env.LSHARE_MINIO_CACHE
    ? resolve(process.env.LSHARE_MINIO_CACHE)
    : join(root, '.cloudflare/tools')
  const file = join(cache, asset)
  await mkdir(dirname(file), { recursive: true })
  const verify = async (path: string) => {
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(path)) hash.update(bytes)
    if (hash.digest('hex') !== digest)
      throw new Error(
        'The downloaded MinIO binary failed SHA-256 verification.',
      )
  }
  if ((await stat(file).catch(() => null))?.isFile()) {
    await verify(file)
    return file
  }
  const partial = file + '.' + randomUUID()
  try {
    const response = await fetch(
      'https://github.com/minio/minio/releases/download/' +
        version +
        '/' +
        asset,
    )
    if (!response.ok || !response.body)
      throw new Error(
        'MinIO download failed. Set MINIO_BINARY to an installed server.',
      )
    await pipeline(
      readable(response.body),
      createWriteStream(partial, { mode: 0o700, flags: 'wx' }),
    )
    await verify(partial)
    await chmod(partial, 0o700)
    await rename(partial, file)
  } finally {
    await rm(partial, { force: true })
  }
  return file
}

async function port() {
  const server = createServer()
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  await new Promise<void>((done, reject) =>
    server.close((e) => (e ? reject(e) : done())),
  )
  if (!address || typeof address === 'string')
    throw new Error('Could not allocate a loopback port.')
  return address.port
}

async function ready(url: string, child: Subprocess, signal: AbortSignal) {
  for (let i = 0; i < 150; i++) {
    signal.throwIfAborted()
    if (child.exitCode !== null)
      throw new Error(
        'Local fixture exited with status ' + child.exitCode + '.',
      )
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(900) })
      await response.body?.cancel()
      if (response.ok) return
    } catch {
      signal.throwIfAborted()
    }
    await delay(200, undefined, { signal })
  }
  throw new Error('Local service did not become ready at ' + url + '.')
}
async function stop(child?: Subprocess) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000)
  try {
    await child.exited
  } finally {
    clearTimeout(timer)
  }
}

async function capture(
  stream: ReadableStream<Uint8Array>,
  mailbox: string,
  diagnostics: string[],
  secretValues: string[],
) {
  let to = '',
    subject = ''
  for await (const line of createInterface({ input: readable(stream) })) {
    const clean = Bun.stripANSI(line).trim()
    if (clean.startsWith('To: ')) to = clean.slice(4)
    if (clean.startsWith('Subject: ')) subject = clean.slice(9)
    if (clean.startsWith('Text: ') && to && subject) {
      const filename = clean.slice(6)
      if (
        !/^[\w.@-]+\.txt$/.test(basename(filename)) ||
        !filename.includes('email-text')
      )
        throw new Error(
          'Unexpected simulated email file named ' +
            basename(filename).replace(/[0-9]{8,}/g, 'x') +
            '.',
        )
      const text = await readFile(filename, 'utf8')
      const target = join(mailbox, randomUUID())
      await writeFile(target, JSON.stringify({ to, subject, text }), {
        mode: 0o600,
      })
      await rename(target, target + '.json')
      to = ''
      subject = ''
    }
    if (
      /error|exception|failed|fatal/i.test(clean) &&
      !/[?&]X-Amz-|\b\d{8}\b|email-text/i.test(clean)
    ) {
      let safe = clean.slice(0, 500)
      for (const secret of secretValues)
        safe = safe.replaceAll(secret, '[redacted]')
      diagnostics.push(safe)
      if (diagnostics.length > 12) diagnostics.shift()
    }
  }
}
const tmp = await mkdtemp(join(tmpdir(), 'lshare-cloud-'))
const signal = new AbortController()
let minio: Subprocess | undefined,
  wrangler: Subprocess | undefined,
  runner: Subprocess | undefined
const reads: Promise<void>[] = []
const diagnostics: string[] = []
function interrupt() {
  signal.abort()
  runner?.kill('SIGTERM')
}
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)
try {
  const ports = new Set<number>()
  while (ports.size < 4) ports.add(await port())
  const [http, storage, consolePort, inspector] = [...ports]
  const app = 'http://127.0.0.1:' + http,
    s3 = 'http://127.0.0.1:' + storage
  const spool = join(tmp, 'mail'),
    assets = join(tmp, 'assets')
  await mkdir(spool, { mode: 0o700 })
  await stageCloudAssets(assets)
  const key = randomBytes(10).toString('hex'),
    secret = randomBytes(32).toString('base64url'),
    bucket = 'lshare-objects'
  const base = {
    PATH: process.env.PATH,
    HOME: tmp,
    TMPDIR: tmp,
    NO_PROXY: '127.0.0.1,localhost,::1',
    WRANGLER_SEND_METRICS: 'false',
    NO_COLOR: '1',
    CI: '1',
  }
  minio = Bun.spawn(
    [
      await minioBinary(),
      'server',
      join(tmp, 'objects'),
      '--address',
      '127.0.0.1:' + storage,
      '--console-address',
      '127.0.0.1:' + consolePort,
    ],
    {
      cwd: tmp,
      env: {
        ...base,
        MINIO_ROOT_USER: key,
        MINIO_ROOT_PASSWORD: secret,
        MINIO_BROWSER: 'off',
        MINIO_SITE_REGION: 'auto',
        MINIO_API_CORS_ALLOW_ORIGIN: app,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const read = (stream: ReadableStream<Uint8Array>) => {
    reads.push(
      capture(stream, spool, diagnostics, [key, secret]).catch(
        (error: unknown) => {
          diagnostics.push(
            error instanceof Error
              ? error.message
              : 'Simulated mail capture failed.',
          )
          interrupt()
        },
      ),
    )
  }
  read(minio.stdout as ReadableStream<Uint8Array>)
  read(minio.stderr as ReadableStream<Uint8Array>)
  await ready(s3 + '/minio/health/ready', minio, signal.signal)
  const signer = new AwsClient({
    accessKeyId: key,
    secretAccessKey: secret,
    service: 's3',
    region: 'auto',
    retries: 0,
  })
  for (let attempt = 0; ; attempt++) {
    const created = await signer.fetch(s3 + '/' + bucket, {
      method: 'PUT',
      body: '<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>auto</LocationConstraint></CreateBucketConfiguration>',
    })
    if (created.ok) break
    const code = (await created.text()).match(/<Code>([^<]+)<\/Code>/)?.[1]
    if (created.status === 409 && code === 'BucketAlreadyOwnedByYou') break
    if (created.status !== 503 || attempt >= 20)
      throw new Error(
        'Could not initialize the private MinIO bucket (' +
          created.status +
          ', ' +
          (code ?? 'unknown') +
          ').',
      )
    await delay(200, undefined, { signal: signal.signal })
  }
  const config = await Bun.file(join(root, 'wrangler.jsonc')).json()
  delete config.$schema
  delete config.routes
  delete config.triggers
  delete config.secrets
  config.main = join(root, 'scripts/cloud-worker-fixture.mjs')
  config.assets.directory = assets
  config.vars = {
    PUBLIC_ORIGIN: app,
    R2_ACCOUNT_ID: '0'.repeat(32),
    R2_BUCKET_NAME: bucket,
    R2_ACCESS_KEY_ID: key,
    R2_SECRET_ACCESS_KEY: secret,
    LOCAL_S3_ORIGIN: s3,
    MAIL_FROM: 'signin@example.test',
    ALERT_EMAIL: 'ops@example.test',
  }
  const configFile = join(tmp, 'wrangler.json')
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 })
  wrangler = Bun.spawn(
    [
      'node',
      join(root, 'node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(http),
      '--inspector-port',
      String(inspector),
      '--persist-to',
      join(tmp, 'state'),
      '--config',
      configFile,
      '--test-scheduled',
    ],
    { cwd: tmp, stdout: 'pipe', stderr: 'pipe', env: base },
  )
  read(wrangler.stdout as ReadableStream<Uint8Array>)
  read(wrangler.stderr as ReadableStream<Uint8Array>)
  await ready(app + '/', wrangler, signal.signal)
  console.log(
    'Local workerd at ' + app + ', separate S3 service at ' + s3 + '.',
  )
  const args = Bun.argv.slice(2)
  const smokeOnly = args.includes('--smoke-only')
  const browserOnly = args.includes('--browser-only')
  if (browserOnly && smokeOnly) throw new Error('Select one fixture mode.')
  if (!browserOnly) {
    const { smoke } = await import('./cloud-smoke')
    await smoke(app, s3, spool, smokeOnly)
  }
  if (!smokeOnly) {
    const noProxy = [
      process.env.NO_PROXY ?? process.env.no_proxy,
      'localhost',
      '127.0.0.1',
      '::1',
    ]
      .filter(Boolean)
      .join(',')
    runner = Bun.spawn(
      [
        'node',
        'node_modules/e2e/dist/cli/bin.js',
        'run',
        '--config',
        'cloudflare/e2e.config.ts',
        ...args.filter((arg) => arg !== '--browser-only'),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          E2E_MAIL_SPOOL: spool,
          E2E_APP_URL: app,
          E2E_STORAGE_ORIGIN: s3,
          E2E_SECRET_CLOUD_LINK_PASSWORD: randomBytes(24).toString('base64url'),
          NO_PROXY: noProxy,
          no_proxy: noProxy,
        },
        stdout: 'inherit',
        stderr: 'inherit',
        stdin: 'inherit',
      },
    )
    process.exitCode = await runner.exited
  }
} catch (error) {
  for (const diagnostic of diagnostics) console.error(diagnostic)
  console.error(
    error instanceof Error ? error.message : 'Cloud fixture failed.',
  )
  process.exitCode = 1
} finally {
  await stop(runner)
  await stop(wrangler)
  await stop(minio)
  await Promise.allSettled(reads)
  await rm(tmp, { force: true, recursive: true })
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', interrupt)
}
