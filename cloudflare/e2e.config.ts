import { web } from '@e2e-dev/web'
import type { E2EConfig } from 'e2e'
import { chatgpt } from 'e2e/oauth/chatgpt'
import { readVerificationCode } from './browser/mailbox.ts'

const url = process.env.E2E_APP_URL
if (
  !url ||
  new URL(url).hostname !== '127.0.0.1' ||
  !process.env.E2E_MAIL_SPOOL
)
  throw new Error(
    'Run the disposable local Cloudflare fixture to test verification and direct uploads.',
  )

const browser = process.env.E2E_BROWSER || 'chromium'
if (browser !== 'chromium' && browser !== 'firefox')
  throw new Error('Unknown e2e browser.')

export default {
  projectId: 'lshare-cloud',
  tests: ['browser/**/*.e2e.ts'],
  agents: {
    default: { model: chatgpt(process.env.E2E_CHATGPT_MODEL || 'gpt-6-luna') },
  },
  secrets: {
    ownerCode: () => readVerificationCode('owner'),
    senderCode: () => readVerificationCode('sender'),
    wrongPassword: () => crypto.randomUUID(),
    cloudLinkPassword: () => process.env.E2E_SECRET_CLOUD_LINK_PASSWORD || '',
  },
  targets: [{ engine: web({ browser }), app: { url } }],
} satisfies E2EConfig
