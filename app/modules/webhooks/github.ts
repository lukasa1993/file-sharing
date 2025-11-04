import type { RequestContext } from '@remix-run/fetch-router'

type GithubPushPayload = {
  ref: string
  after: string
  repository: {
    full_name: string
  }
}

type CommandResult = {
  code: number
  stdout: string
  stderr: string
}

type QueueStatus = 'busy' | 'queued'

const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

let updateInFlight: Promise<void> | null = null

function hexToBytes(value: string): Uint8Array | null {
  if (value.length % 2 !== 0) return null
  const result = new Uint8Array(value.length / 2)

  for (let index = 0; index < value.length; index += 2) {
    const byte = Number.parseInt(value.slice(index, index + 2), 16)
    if (Number.isNaN(byte)) return null
    result[index / 2] = byte
  }

  return result
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index]
  }
  return diff === 0
}

async function verifySignature(
  secret: string,
  payload: ArrayBuffer,
  signature: string,
): Promise<boolean> {
  const prefix = 'sha256='
  if (!signature.startsWith(prefix)) return false

  const provided = hexToBytes(signature.slice(prefix.length))
  if (!provided) return false

  const key = await crypto.subtle.importKey('raw', textEncoder.encode(secret), 'HMAC', false, [
    'sign',
  ])
  const expected = await crypto.subtle.sign({ name: 'HMAC', hash: 'SHA-256' }, key, payload)

  return timingSafeEqual(new Uint8Array(expected), provided)
}

function isGithubPushPayload(payload: unknown): payload is GithubPushPayload {
  if (typeof payload !== 'object' || payload === null) return false
  const record = payload as Record<string, unknown>
  if (typeof record.ref !== 'string') return false
  if (typeof record.after !== 'string') return false

  const repository = record.repository
  if (typeof repository !== 'object' || repository === null) return false
  if (typeof (repository as Record<string, unknown>).full_name !== 'string') return false

  return true
}

async function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  const proc = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'pipe' })

  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()
  const code = await proc.exited
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])

  return { code, stdout, stderr }
}

function queueUpdate(): QueueStatus {
  if (updateInFlight) return 'busy'

  updateInFlight = runCommand('git', ['pull'])
    .then((result) => {
      const timestamp = new Date().toISOString()
      if (result.code === 0) {
        console.log(`[${timestamp}] GitHub webhook git pull success: ${result.stdout.trim()}`)
      } else {
        console.error(
          `[${timestamp}] GitHub webhook git pull failed (${result.code}): ${result.stderr.trim()}`,
        )
      }
    })
    .catch((error: unknown) => {
      const timestamp = new Date().toISOString()
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${timestamp}] GitHub webhook git pull error: ${message}`)
    })
    .finally(() => {
      updateInFlight = null
    })

  return 'queued'
}

export async function githubWebhookHandler({ request }: RequestContext): Promise<Response> {
  const secret = Bun.env.GITHUB_WEBHOOK_SECRET
  if (!secret) {
    console.error('Missing GITHUB_WEBHOOK_SECRET environment variable')
    return Response.json({ error: 'Webhook secret not configured' }, { status: 500 })
  }

  const signature = request.headers.get('x-hub-signature-256')
  if (!signature)
    return Response.json({ error: 'Missing X-Hub-Signature-256 header' }, { status: 400 })

  const event = request.headers.get('x-github-event')
  if (!event) return Response.json({ error: 'Missing X-GitHub-Event header' }, { status: 400 })

  const payloadBuffer = await request.arrayBuffer()
  const signatureValid = await verifySignature(secret, payloadBuffer, signature)
  if (!signatureValid) return Response.json({ error: 'Invalid signature' }, { status: 401 })

  if (event === 'ping') {
    return Response.json({ ok: true })
  }

  if (event !== 'push') {
    return Response.json({ ignored: true, reason: `Unsupported event: ${event}` }, { status: 202 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(textDecoder.decode(payloadBuffer))
  } catch {
    return Response.json({ error: 'Invalid JSON payload' }, { status: 400 })
  }

  if (!isGithubPushPayload(payload)) {
    return Response.json({ error: 'Unsupported payload shape' }, { status: 400 })
  }

  const status = queueUpdate()
  if (status === 'busy') {
    return Response.json(
      {
        accepted: true,
        status: 'already-running',
        commit: payload.after,
      },
      { status: 202 },
    )
  }

  return Response.json(
    {
      accepted: true,
      status: 'queued',
      commit: payload.after,
    },
    { status: 202 },
  )
}
