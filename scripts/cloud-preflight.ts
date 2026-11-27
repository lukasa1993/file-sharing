import { AwsClient } from 'aws4fetch'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emailAddress } from '../cloudflare/mail'
import { stageCloudAssets } from './cloud-assets'

export const cloudRoot = fileURLToPath(new URL('../', import.meta.url))
const api = 'https://api.cloudflare.com/client/v4'
const origin = 'https://dl.ldev.cloud'
const host = new URL(origin).hostname
const bucket = 'lshare-objects'
const service = 'lshare'
const schema = 'sqlite-catalog-v1'
type Account = {
  account: string
  jurisdiction: string
  mailer: string
  alert: string
  access: string
  secret: string
}
type Rule = {
  allowed: { origins: string[]; methods: string[]; headers: string[] }
  exposeHeaders: string[]
  maxAgeSeconds: number
}

const cors: Rule = {
  allowed: {
    origins: [origin],
    methods: ['GET', 'HEAD', 'PUT'],
    headers: ['Content-Type', 'Range'],
  },
  exposeHeaders: [
    'ETag',
    'Content-Length',
    'Content-Range',
    'Accept-Ranges',
    'Content-Disposition',
  ],
  maxAgeSeconds: 3600,
}

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error('Provide ' + name + ' as a deployment secret.')
  return value
}
export function deploymentAccount(prepare = false): Account {
  const account = required('CLOUDFLARE_ACCOUNT_ID')
  if (
    !/^[0-9a-f]{32}$/.test(account) ||
    (process.env.R2_ACCOUNT_ID && process.env.R2_ACCOUNT_ID !== account)
  )
    throw new Error(
      'Cloudflare and signer account IDs must identify the same account.',
    )
  const jurisdiction = process.env.R2_JURISDICTION ?? ''
  if (jurisdiction && !['eu', 'fedramp'].includes(jurisdiction))
    throw new Error('Unsupported R2 jurisdiction.')
  const mailer = emailAddress(required('MAIL_FROM')),
    alert = emailAddress(required('ALERT_EMAIL'))
  if (!mailer || !alert)
    throw new Error('Both private email settings must be valid addresses.')
  if (process.env.R2_BUCKET_NAME && process.env.R2_BUCKET_NAME !== bucket)
    throw new Error('The configured dedicated bucket is lshare-objects.')
  const bootstrap =
    prepare &&
    !process.env.R2_ACCESS_KEY_ID &&
    !process.env.R2_SECRET_ACCESS_KEY
  return {
    account,
    jurisdiction,
    mailer,
    alert,
    access: bootstrap ? '' : required('R2_ACCESS_KEY_ID'),
    secret: bootstrap ? '' : required('R2_SECRET_ACCESS_KEY'),
  }
}

async function authToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return required('CLOUDFLARE_API_TOKEN')
  const child = Bun.spawn(
    [
      'node',
      join(cloudRoot, 'node_modules/wrangler/bin/wrangler.js'),
      'auth',
      'token',
      '--json',
    ],
    {
      cwd: cloudRoot,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdout: 'pipe',
      stderr: 'ignore',
    },
  )
  const raw = await new Response(child.stdout).text()
  if ((await child.exited) !== 0)
    throw new Error('Sign into Wrangler or provide CLOUDFLARE_API_TOKEN.')
  const token: unknown = JSON.parse(raw)
  if (
    !token ||
    typeof token !== 'object' ||
    !('token' in token) ||
    typeof token.token !== 'string'
  )
    throw new Error(
      'An account API token or Wrangler OAuth session is required.',
    )
  return token.token
}

type Result = Record<string, unknown>
function records(value: unknown): Result[] {
  if (
    !Array.isArray(value) ||
    value.some((x) => !x || typeof x !== 'object' || Array.isArray(x))
  )
    throw new Error('Unexpected Cloudflare API list response.')
  return value
}
function record(value: unknown): Result {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Unexpected Cloudflare API response.')
  return value as Result
}
function sameValues(values: unknown, want: string[]) {
  return (
    Array.isArray(values) &&
    values.every((x) => typeof x === 'string') &&
    values
      .map((x) => x.toLowerCase())
      .sort()
      .join('\n') ===
      want
        .map((x) => x.toLowerCase())
        .sort()
        .join('\n')
  )
}
export function validCors(rules: unknown) {
  const entries = records(rules)
  if (entries.length !== 1) return false
  const row = entries[0]!,
    allowed = record(row.allowed)
  return (
    sameValues(allowed.origins, cors.allowed.origins) &&
    sameValues(allowed.methods, cors.allowed.methods) &&
    sameValues(allowed.headers, cors.allowed.headers) &&
    sameValues(row.exposeHeaders, cors.exposeHeaders)
  )
}

export async function checkAccount(settings: Account, prepare: boolean) {
  const token = await authToken()
  const { account, jurisdiction } = settings
  const base = '/accounts/' + account,
    r2 = base + '/r2/buckets',
    object = r2 + '/' + bucket
  async function request(
    path: string,
    opts: { method?: string; body?: unknown; missing?: boolean } = {},
  ): Promise<unknown> {
    const page = new URL(api + path)
    const rows: unknown[] = []
    let number = 1
    for (;;) {
      const response = await fetch(page, {
        method: opts.method ?? 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(25_000),
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          ...(jurisdiction && path.startsWith(r2)
            ? { 'cf-r2-jurisdiction': jurisdiction }
            : {}),
        },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      })
      const json = (await response.json()) as {
        success?: boolean
        errors?: { code: number }[]
        result?: unknown
        result_info?: { page?: number; total_pages?: number }
      }
      if (opts.missing && response.status === 404) return null
      if (!response.ok || !json.success)
        throw new Error(
          'Cloudflare prerequisite check returned ' +
            response.status +
            ' (code ' +
            (json.errors?.[0]?.code ?? 'unknown') +
            '). Check account permissions and enabled services.',
        )
      const remaining = (json.result_info?.total_pages ?? 1) > number
      if (!remaining && number === 1) return json.result
      if (!Array.isArray(json.result) || (opts.method && opts.method !== 'GET'))
        throw new Error('Unexpected paginated Cloudflare response.')
      rows.push(...json.result)
      if (!remaining) return rows
      number++
      page.searchParams.set('page', String(number))
    }
  }
  async function zone(domain: string) {
    let label = domain
    while (label.includes('.')) {
      const answer = records(
        await request(
          '/zones?' +
            new URLSearchParams({
              name: label,
              'account.id': account,
              status: 'active',
            }),
        ),
      )
      if (answer.length === 1 && typeof answer[0]?.id === 'string')
        return answer[0].id
      label = label.slice(label.indexOf('.') + 1)
    }
    throw new Error(
      'An active DNS zone for the hostname or sender is missing from this account.',
    )
  }
  await request(base)
  const zoneId = await zone(host)
  const sender = settings.mailer.split('@')[1]!
  const senderZone = await zone(sender)
  const configured = records(
    await request('/zones/' + senderZone + '/email/sending/subdomains'),
  )
  const senderEntry = configured.find(
    (x) => x.name === sender && x.enabled === true,
  )
  if (!senderEntry || typeof senderEntry.tag !== 'string')
    throw new Error(
      'Enable the private sender domain in Cloudflare Email Sending and verify its DNS records before deploying.',
    )
  const requiredDns = records(
    await request(
      '/zones/' +
        senderZone +
        '/email/sending/subdomains/' +
        encodeURIComponent(senderEntry.tag) +
        '/dns',
    ),
  )
  if (!requiredDns.length)
    throw new Error(
      'Email Sending returned no DNS records for the configured sender domain.',
    )
  function canonicalDns(type: string, text: unknown) {
    const value = String(text).trim()
    if (type === 'TXT') return value.replace(/^"|"$/g, '').replace(/"\s*"/g, '')
    return value.toLowerCase().replace(/\.$/, '')
  }
  for (const required of requiredDns) {
    const { type, name, content, priority } = required
    if (
      typeof type !== 'string' ||
      typeof name !== 'string' ||
      typeof content !== 'string'
    )
      throw new Error(
        'Email Sending returned an unrecognized DNS prerequisite.',
      )
    const found = records(
      await request(
        '/zones/' +
          senderZone +
          '/dns_records?' +
          new URLSearchParams({ name: name.replace(/\.$/, ''), type }),
      ),
    )
    if (
      !found.some(
        (x) =>
          x.type === type &&
          canonicalDns(type, x.content) === canonicalDns(type, content) &&
          (priority === undefined ||
            priority === null ||
            x.priority === priority),
      )
    )
      throw new Error(
        'Required DNS records for the private sender domain do not match Email Sending.',
      )
  }
  const existing = await request(
    base + '/workers/scripts/' + service + '/settings',
    { missing: true },
  )
  const bindings = existing ? records(record(existing).bindings) : []
  if (existing) {
    const matchingBucket = bindings.some(
      (x) =>
        x.name === 'BUCKET' &&
        x.type === 'r2_bucket' &&
        x.bucket_name === bucket &&
        (x.jurisdiction ?? '') === jurisdiction,
    )
    const matchingWorkspace = bindings.some(
      (x) =>
        x.name === 'WORKSPACE' &&
        x.type === 'durable_object_namespace' &&
        x.class_name === 'CloudWorkspace' &&
        (!x.script_name || x.script_name === service),
    )
    const marker = bindings.some(
      (x) =>
        x.name === 'LSHARE_SCHEMA' &&
        x.type === 'plain_text' &&
        x.text === schema,
    )
    if (!matchingBucket || !matchingWorkspace || !marker)
      throw new Error(
        'Existing Worker bindings identify a different catalog or bucket. Use an explicit migration before sharing this service name.',
      )
  }
  const domains = records(
    await request(
      base +
        '/workers/domains?' +
        new URLSearchParams({ hostname: host, zone_id: zoneId }),
    ),
  ).filter((x) => x.hostname === host)
  if (domains.some((item) => item.service !== service))
    throw new Error('The custom hostname already belongs to another Worker.')
  if (!domains.length) {
    const dns = records(
      await request(
        '/zones/' +
          zoneId +
          '/dns_records?' +
          new URLSearchParams({ name: host }),
      ),
    )
    if (dns.some((x) => ['A', 'AAAA', 'CNAME'].includes(String(x.type))))
      throw new Error(
        'The custom hostname has an existing DNS destination. Resolve ownership before publishing.',
      )
  }
  const info = await request(object, { missing: true })
  if (!info) {
    if (existing)
      throw new Error(
        'The existing catalog lost its bucket binding. Recover storage before redeploying.',
      )
    if (!prepare)
      throw new Error(
        'The private bucket is absent. Run cloud:deploy --prepare, then scope the S3 credential to it.',
      )
    await request(r2, { method: 'POST', body: { name: bucket } })
  }
  const managed = record(await request(object + '/domains/managed'))
  const custom = records(
    record(await request(object + '/domains/custom')).domains,
  )
  if (managed.enabled !== false || custom.length)
    throw new Error(
      'This application requires a private R2 bucket without a public storage domain.',
    )
  const url =
    'https://' +
    account +
    (jurisdiction ? '.' + jurisdiction : '') +
    '.r2.cloudflarestorage.com/' +
    bucket
  if (settings.access && settings.secret) {
    const signer = new AwsClient({
      accessKeyId: settings.access,
      secretAccessKey: settings.secret,
      service: 's3',
      region: 'auto',
      retries: 0,
    })
    async function inventory(
      query: string,
      rootElement: string,
      entry: string,
    ) {
      const res = await signer.fetch(url + '?' + query, {
        redirect: 'error',
        signal: AbortSignal.timeout(25_000),
      })
      if (!res.ok)
        throw new Error(
          'Bucket-scoped S3 credentials must be able to list objects and multipart uploads.',
        )
      const xml = await res.text()
      if (!xml.includes('<' + rootElement))
        throw new Error(
          'Object storage returned an unrecognized inventory response.',
        )
      if (
        !existing &&
        (xml.includes('<' + entry + '>') ||
          /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml))
      )
        throw new Error(
          'A fresh catalog requires an empty, exclusively owned bucket without active multipart uploads.',
        )
    }
    await inventory('list-type=2&max-keys=1', 'ListBucketResult', 'Contents')
    await inventory(
      'uploads=&max-uploads=1',
      'ListMultipartUploadsResult',
      'Upload',
    )
  } else if (!prepare || info) {
    throw new Error(
      'Supply bucket-scoped S3 credentials to check an existing bucket before changing its CORS policy.',
    )
  }
  const policyLife = record(await request(object + '/lifecycle'))
  const lifecycle = records(policyLife.rules).filter((r) => r.enabled !== false)
  for (const item of lifecycle) {
    const prefix = String(record(item.conditions ?? {}).prefix ?? '')
    if (prefix && !prefix.startsWith('files/') && !'files/'.startsWith(prefix))
      continue
    if (item.deleteObjectsTransition) {
      const condition = record(record(item.deleteObjectsTransition).condition)
      if (
        condition.type !== 'Age' ||
        typeof condition.maxAge !== 'number' ||
        condition.maxAge < 31 * 86400
      )
        throw new Error(
          'A bucket lifecycle rule could remove an object before its 30-day retention ends.',
        )
    }
    if (item.abortMultipartUploadsTransition) {
      const condition = record(
        record(item.abortMultipartUploadsTransition).condition,
      )
      if (
        condition.type !== 'Age' ||
        typeof condition.maxAge !== 'number' ||
        condition.maxAge < 86400
      )
        throw new Error('A bucket lifecycle rule could abort an active upload.')
    }
  }
  const policy = await request(object + '/cors', { missing: true })
  const rules = records(policy ? record(policy).rules : [])
  if (!validCors(rules)) {
    if (!prepare || rules.length)
      throw new Error(
        'The bucket requires the documented single-origin CORS policy. Existing CORS policies require operator review.',
      )
    await request(object + '/cors', { method: 'PUT', body: { rules: [cors] } })
    if (!validCors(record(await request(object + '/cors')).rules))
      throw new Error('Stored CORS policy did not verify.')
  }
}

export async function pack(config: Account | null, publish: boolean) {
  const temp = await mkdtemp(join(tmpdir(), 'lshare-worker-build-'))
  try {
    const manifest = await Bun.file(join(cloudRoot, 'wrangler.jsonc')).json()
    delete manifest.$schema
    manifest.main = join(cloudRoot, 'cloudflare/worker.ts')
    manifest.assets.directory = join(temp, 'public')
    await stageCloudAssets(manifest.assets.directory)
    if (config) {
      manifest.account_id = config.account
      manifest.vars.R2_ACCOUNT_ID = config.account
      if (config.jurisdiction) {
        manifest.vars.R2_JURISDICTION = config.jurisdiction
        manifest.r2_buckets[0].jurisdiction = config.jurisdiction
      }
    }
    const file = join(temp, 'wrangler.json')
    await writeFile(file, JSON.stringify(manifest), { mode: 0o600 })
    const args = [
      'node',
      join(cloudRoot, 'node_modules/wrangler/bin/wrangler.js'),
      'deploy',
      '--config',
      file,
    ]
    if (publish) {
      if (!config) throw new Error('Validated deployment settings required.')
      const secrets = join(temp, 'secrets.json')
      await writeFile(
        secrets,
        JSON.stringify({
          R2_ACCESS_KEY_ID: config.access,
          R2_SECRET_ACCESS_KEY: config.secret,
          MAIL_FROM: config.mailer,
          ALERT_EMAIL: config.alert,
        }),
        { mode: 0o600 },
      )
      args.push('--secrets-file', secrets)
    } else args.push('--dry-run', '--outdir', join(temp, 'bundle'))
    const child = Bun.spawn(args, {
      cwd: cloudRoot,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'ignore',
    })
    if ((await child.exited) !== 0)
      throw new Error(
        publish
          ? 'Wrangler did not finish publishing. Check the deployment status in Workers.'
          : 'Wrangler dry run failed.',
      )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
if (import.meta.main) await pack(null, false)
