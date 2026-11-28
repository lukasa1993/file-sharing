// Cloudflare Email Service accepts structured messages on its send_email binding.
export interface CloudMailEnv {
  EMAIL?: {
    send(message: {
      from: string
      to: string
      subject: string
      text: string
    }): Promise<unknown>
  }
  MAIL_FROM?: string
  ALERT_EMAIL?: string
}

export function emailAddress(value: unknown): string | null {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value))
    return null
  const address = value.trim().toLowerCase()
  const parts = address.split('@')
  const [local, domain] = parts
  if (
    parts.length !== 2 ||
    address.length > 254 ||
    !local ||
    local.length > 64 ||
    !domain
  )
    return null
  if (
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..')
  )
    return null
  const labels = domain.split('.')
  if (
    labels.length < 2 ||
    !labels.every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  )
    return null
  return address
}

async function deliver(
  env: CloudMailEnv,
  to: string,
  subject: string,
  text: string,
) {
  const from = emailAddress(env.MAIL_FROM)
  if (!env.EMAIL || !from || !emailAddress(to))
    throw new Error('Email service is unavailable.')
  try {
    await env.EMAIL.send({ from, to, subject, text })
  } catch {
    throw new Error('Email service is unavailable.')
  }
}

export async function sendVerificationCode(
  env: CloudMailEnv,
  to: string,
  code: string,
) {
  await deliver(
    env,
    to,
    'Your lshare sign-in code',
    'Your sign-in code is ' +
      code +
      '.\n\nEnter it in the browser where you requested it within 10 minutes. If you did not request a code, you can ignore this email.',
  )
}

export async function sendCapacityAlert(env: CloudMailEnv, details: string) {
  const to = emailAddress(env.ALERT_EMAIL)
  if (!to) throw new Error('The capacity alert recipient is unavailable.')
  await deliver(env, to, 'lshare capacity alert', details)
}
