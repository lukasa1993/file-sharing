import type { E2EConfig } from 'e2e'
import { web } from '@e2e-dev/web'
import { chatgpt } from 'e2e/oauth/chatgpt'

const localOrigin = 'http://127.0.0.1:8080'
const appUrl = process.env.APP_URL || localOrigin

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
  targets: [
    {
      engine: web(),
      app: {
        url: appUrl,
        readyUrl: new URL('/readyz', appUrl).href,
        permissions: { 'clipboard-read': 'grant', 'clipboard-write': 'grant' },
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
