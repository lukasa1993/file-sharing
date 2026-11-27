import { expect, spyOn, test } from 'bun:test'
import { checkAccount } from '../../scripts/cloud-preflight'

const account = '0123456789abcdef0123456789abcdef'
const settings = {
  account,
  jurisdiction: '',
  mailer: 'sender@example.test',
  alert: 'alerts@example.test',
  access: 'fixture-access',
  secret: 'fixture-secret',
}
const database = {
  type: 'durable_object_namespace',
  name: 'WORKSPACE',
  class_name: 'CloudWorkspace',
}
const store = {
  type: 'r2_bucket',
  name: 'BUCKET',
  bucket_name: 'lshare-objects',
}
const schema = {
  type: 'plain_text',
  name: 'LSHARE_SCHEMA',
  text: 'sqlite-catalog-v1',
}
const cors = {
  allowed: {
    origins: ['https://dl.ldev.cloud'],
    methods: ['PUT', 'GET', 'HEAD'],
    headers: ['Range', 'Content-Type'],
  },
  exposeHeaders: [
    'Content-Range',
    'ETag',
    'Accept-Ranges',
    'Content-Disposition',
    'Content-Length',
  ],
}
type Scenario = {
  bucket?: boolean
  bindings?: unknown[]
  objects?: boolean
  multipart?: boolean
  public?: boolean
  domains?: unknown[]
  cors?: unknown[]
  lifecycles?: unknown[]
  dns?: boolean
  sender?: boolean
}
async function mocked(
  options: Scenario,
  run: (published: string[]) => Promise<void>,
) {
  const calls: string[] = []
  let bucket = options.bucket ?? true
  let corsRules = options.cors ?? [cors]
  const old = process.env.CLOUDFLARE_API_TOKEN
  process.env.CLOUDFLARE_API_TOKEN = 'disposable-cloud-preflight'
  async function localFetch(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) {
    const req = new Request(input, init)
    const url = new URL(req.url)
    const path = url.pathname
    if (url.hostname.endsWith('.r2.cloudflarestorage.com')) {
      expect(req.headers.get('authorization')).toContain('AWS4-HMAC-SHA256')
      if (url.searchParams.has('uploads'))
        return new Response(
          '<ListMultipartUploadsResult>' +
            (options.multipart ? '<Upload></Upload>' : '') +
            '</ListMultipartUploadsResult>',
        )
      return new Response(
        '<ListBucketResult>' +
          (options.objects ? '<Contents></Contents>' : '') +
          '</ListBucketResult>',
      )
    }
    expect(url.origin).toBe('https://api.cloudflare.com')
    if (req.method !== 'GET') calls.push(req.method + ' ' + path)
    const ok = (result: unknown) => Response.json({ success: true, result })
    const missing = () =>
      Response.json(
        { success: false, errors: [{ code: 10006 }] },
        { status: 404 },
      )
    if (path === '/client/v4/accounts/' + account) return ok({ id: account })
    if (path === '/client/v4/zones') return ok([{ id: 'zone' }])
    if (path.endsWith('/email/sending/subdomains'))
      return ok([
        {
          name: 'example.test',
          tag: 'mailtag',
          enabled: options.sender ?? true,
        },
      ])
    if (path.endsWith('/email/sending/subdomains/mailtag/dns'))
      return ok([
        {
          type: 'CNAME',
          name: 'mail.example.test',
          content: 'return.example.test.',
        },
      ])
    if (path.endsWith('/dns_records') && url.searchParams.has('type'))
      return ok(
        options.dns === false
          ? []
          : [
              {
                type: 'CNAME',
                name: 'mail.example.test',
                content: 'return.example.test',
              },
            ],
      )
    if (path.endsWith('/workers/scripts/lshare/settings'))
      return options.bindings ? ok({ bindings: options.bindings }) : missing()
    if (path.endsWith('/workers/domains')) return ok(options.domains ?? [])
    if (path.endsWith('/dns_records')) return ok([])
    if (path.endsWith('/lshare-objects'))
      return bucket ? ok({ name: 'lshare-objects' }) : missing()
    if (path.endsWith('/r2/buckets') && req.method === 'POST') {
      bucket = true
      return ok({ name: 'lshare-objects' })
    }
    if (path.endsWith('/domains/managed'))
      return ok({ enabled: options.public ?? false })
    if (path.endsWith('/domains/custom')) return ok({ domains: [] })
    if (path.endsWith('/lifecycle'))
      return ok({ rules: options.lifecycles ?? [] })
    if (path.endsWith('/cors')) {
      if (req.method === 'PUT')
        corsRules = ((await req.json()) as { rules: unknown[] }).rules
      return ok({ rules: corsRules })
    }
    throw new Error('Unexpected Cloudflare resource lookup.')
  }
  const request = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(localFetch, { preconnect: globalThis.fetch.preconnect }),
  )
  try {
    await run(calls)
  } finally {
    request.mockRestore()
    if (old === undefined) delete process.env.CLOUDFLARE_API_TOKEN
    else process.env.CLOUDFLARE_API_TOKEN = old
  }
}

test('first install checks empty object and multipart inventories before updating storage', async () => {
  for (const values of [{ objects: true }, { multipart: true }]) {
    await mocked({ ...values, cors: [] }, async (calls) => {
      await expect(checkAccount(settings, true)).rejects.toThrow(
        'empty, exclusively owned bucket',
      )
      expect(calls).toEqual([])
    })
  }
})
test('prepare creates only the dedicated bucket and CORS before bucket-scoped credentials exist', async () => {
  await mocked({ bucket: false, cors: [] }, async (calls) => {
    await checkAccount({ ...settings, access: '', secret: '' }, true)
    expect(calls).toEqual([
      'POST /client/v4/accounts/' + account + '/r2/buckets',
      'PUT /client/v4/accounts/' + account + '/r2/buckets/lshare-objects/cors',
    ])
  })
  await mocked({ cors: [] }, async (calls) => {
    await expect(
      checkAccount({ ...settings, access: '', secret: '' }, true),
    ).rejects.toThrow('Supply bucket-scoped')
    expect(calls).toEqual([])
  })
})
test('read-only preflight preserves stored objects on a recognized redeployment', async () => {
  await mocked(
    { bindings: [store, schema, database], objects: true, multipart: true },
    async (calls) => {
      await checkAccount(settings, false)
      expect(calls).toEqual([])
    },
  )
})
test('preflight preserves conflicting routes, bucket settings, bindings and lifecycle policies', async () => {
  const scenarios: [Scenario, string][] = [
    [{ public: true }, 'private R2 bucket'],
    [{ bindings: [store, database] }, 'different catalog'],
    [
      { domains: [{ hostname: 'dl.ldev.cloud', service: 'another' }] },
      'another Worker',
    ],
    [
      { cors: [{ ...cors, allowed: { ...cors.allowed, origins: ['*'] } }] },
      'single-origin CORS',
    ],
    [{ sender: false }, 'sender domain'],
    [{ dns: false }, 'Required DNS records'],
    [
      {
        lifecycles: [
          {
            enabled: true,
            conditions: { prefix: 'files/' },
            deleteObjectsTransition: {
              condition: { type: 'Age', maxAge: 86400 },
            },
          },
        ],
      },
      '30-day retention',
    ],
  ]
  for (const [scenario, message] of scenarios) {
    await mocked(scenario, async (calls) => {
      await expect(checkAccount(settings, true)).rejects.toThrow(message)
      expect(calls).toEqual([])
    })
  }
})
