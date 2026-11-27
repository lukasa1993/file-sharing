import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app/application.ts'
import { loadConfig } from '../app/config.ts'
import { addCopyStorage } from './fixtures/copy-storage.ts'
import { initialize } from '../scripts/ops.ts'
import { listenHttp } from '../app/transport.ts'

export type Fixture = Awaited<ReturnType<typeof fixture>>
export async function fixture(options: { copyStorage?: boolean } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'fileserver-integration-'))
  const password = randomBytes(24).toString('base64url'),
    storage = join(temp, 'state/storage')
  let instance: Awaited<ReturnType<typeof createApp>> | undefined
  const server = await listenHttp(
    { hostname: '127.0.0.1', port: 0 },
    (req, peer, preparing) => {
      if (!instance) return new Response(null, { status: 503 })
      instance.services.transfers.setPreparationTimeout(req, preparing)
      return instance.fetch(req, peer)
    },
  )
  const origin = server.url.origin
  const close = async () => {
    try {
      await server.stop(true)
      await instance?.close()
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }
  try {
    const root = join(temp, 'state')
    await initialize(root, 'fixture-owner', { password, mountId: 'e2e' })
    if (options.copyStorage) await addCopyStorage(root)
    await writeFile(join(storage, 'handoff.txt'), 'A real handoff\n')
    const env = {
      PUBLIC_ORIGIN: origin,
      PORT: server.url.port,
      DATA_DIR: join(root, 'data'),
      CONFIG_FILE: join(root, 'config/mounts.json'),
      SESSION_SECRET_FILE: join(root, 'config/session.key'),
      BOOTSTRAP_FILE: join(root, 'config/bootstrap.json'),
    }
    instance = await createApp(loadConfig(env))
    const fetchPath = (path: string, init?: RequestInit) =>
      fetch(new URL(path, origin), { redirect: 'manual', ...init })
    async function signIn(credentials?: {
      username: string
      password: string
    }) {
      const login = await fetchPath('/login'),
        html = await login.text()
      const cookie = login.headers.getSetCookie()[0]?.split(';')[0],
        csrf = csrfFrom(html)
      if (!cookie) throw new Error('Missing login session')
      const auth = await fetchPath('/login', {
        method: 'POST',
        headers: { cookie, origin },
        body: new URLSearchParams({
          ...(credentials ?? { username: 'fixture-owner', password }),
          csrf,
        }),
      })
      const newCookie = auth.headers.getSetCookie()[0]?.split(';')[0]
      if (auth.status !== 303 || !newCookie)
        throw new Error('Fixture login failed: ' + auth.status)
      const page = await fetchPath(
        credentials ? '/_/account' : '/_/files?mount=e2e',
        {
          headers: { Cookie: newCookie },
        },
      )
      const fresh = csrfFrom(await page.text())
      return { cookie: newCookie, origin, 'X-CSRF-Token': fresh }
    }
    return {
      origin,
      storage,
      env,
      app: instance,
      fetch: fetchPath,
      signIn,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
function csrfFrom(html: string) {
  const token = /<meta\b[^>]*name="csrf-token"[^>]*content="([^"]+)"/.exec(
    html,
  )?.[1]
  if (!token) throw new Error('CSRF token missing from rendered page')
  return token
}
