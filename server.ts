import { Effect } from 'effect'
import { createApp } from './app/application.ts'
import { loadConfig } from './app/config.ts'
import { asAppError, runTask } from './app/effects.ts'
import { listenHttp } from './app/transport.ts'

export { createApp } from './app/application.ts'

async function main() {
  const config = await runTask(
    Effect.try({ try: () => loadConfig(), catch: asAppError }),
  )
  const app = await createApp(config)
  let server: Awaited<ReturnType<typeof listenHttp>>
  try {
    server = await listenHttp(
      {
        hostname:
          process.env.HOST ??
          (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
        port: config.port,
        publicProtocol: new URL(config.publicOrigin).protocol,
      },
      (request, peer, preparing) => {
        app.services.transfers.setPreparationTimeout(request, preparing)
        return app.fetch(request, peer)
      },
    )
  } catch (error) {
    await app.close()
    throw error
  }
  console.info(JSON.stringify({ event: 'server.ready', port: config.port }))
  try {
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off('SIGINT', stop)
        process.off('SIGTERM', stop)
        resolve()
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
  } finally {
    const force = setTimeout(() => {
      server
        .stop(true)
        .catch(() => console.error('Server forced shutdown failed'))
    }, 10000)
    try {
      await server.stop(false)
    } finally {
      clearTimeout(force)
      await app.close()
    }
    console.info(JSON.stringify({ event: 'server.stopped' }))
  }
}
if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'startup.failed',
        message: error instanceof Error ? error.message : 'Unable to start',
      }),
    )
    process.exitCode = 1
  }
}
