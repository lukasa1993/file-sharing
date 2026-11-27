import type { E2EConfig } from 'e2e'
import { web } from '@e2e-dev/web'
import { chatgpt } from 'e2e/oauth/chatgpt'

const localOrigin = 'http://127.0.0.1:8080'
const appUrl = process.env.APP_URL || localOrigin

const browser = process.env.E2E_BROWSER ?? 'chromium'
if (browser !== 'chromium' && browser !== 'firefox')
  throw new Error('E2E_BROWSER must be chromium or firefox')

export default {
  agents: {
    default: {
      model: chatgpt(process.env.E2E_CHATGPT_MODEL || 'gpt-6-luna'),
    },
  },
  credentials: {
    owner: {
      username: 'e2e-owner',
      password: () => process.env.E2E_USER_OWNER_PASSWORD ?? '',
    },
  },
  secrets: {
    sharePassword: () => process.env.E2E_SECRET_SHARE_PASSWORD ?? '',
    memberPassword: () => process.env.E2E_MEMBER_PASSWORD ?? '',
    replacementPassword: () => process.env.E2E_REPLACEMENT_PASSWORD ?? '',
  },
  targets: [
    {
      engine: web({ browser }),
      app: {
        url: appUrl,
        readyUrl: new URL('/readyz', appUrl).href,
        ...(browser === 'chromium' && {
          permissions: {
            'clipboard-read': 'grant',
            'clipboard-write': 'grant',
          },
        }),
        command: process.env.APP_URL
          ? undefined
          : {
              executable: 'bun',
              args: ['run', '--watch', 'server.ts'],
              env: { PORT: '{port}', PUBLIC_ORIGIN: localOrigin },
              inheritEnv: [
                'DATA_DIR',
                'CONFIG_FILE',
                'SESSION_SECRET_FILE',
                'BOOTSTRAP_FILE',
              ],
              log: '.e2e/logs/server.log',
            },
      },
    },
  ],
} satisfies E2EConfig
