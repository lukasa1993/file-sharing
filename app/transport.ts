import { createServer } from 'node:http'
import { createRequestListener } from 'remix/node-fetch-server'

type Handler = (
  request: Request,
  peer: string | undefined,
  preparingFile: (active: boolean) => void,
) => Response | Promise<Response>

// Bun's node:http implementation preserves Content-Length on streamed file ranges.
// Remix owns Web Request construction, disconnect propagation, backpressure and cookie headers.
export async function listenHttp(
  options: {
    hostname: string
    port: number
    publicProtocol?: string
    idleTimeoutMs?: number
  },
  handler: Handler,
) {
  let closing = false
  const server = createServer(
    { maxHeaderSize: 16384, headersTimeout: 30000 },
    (incoming, outgoing) => {
      if (
        closing ||
        Number(incoming.headers['content-length']) > 32 * 1024 * 1024
      ) {
        outgoing.writeHead(closing ? 503 : 413, { Connection: 'close' })
        outgoing.end()
        return
      }
      // Bun 1.4 applies IncomingMessage.setTimeout as a fixed deadline even
      // during successful response writes. Use socket progress for both
      // directions while Remix retains its normal backpressure and cleanup.
      const socket = incoming.socket
      incoming.setTimeout(0)
      const limit = options.idleTimeoutMs ?? 120000
      let bytes = socket.bytesWritten
      let lastActivity = performance.now()
      let preparing = false
      const idle = (active: boolean) => {
        preparing = active
        lastActivity = performance.now()
      }
      const watch = setInterval(
        () => {
          const current = socket.bytesWritten
          const now = performance.now()
          if (preparing || current !== bytes) {
            bytes = current
            lastActivity = now
          } else if (now - lastActivity >= limit) {
            socket.destroy()
          }
        },
        Math.max(10, Math.floor(limit / 4)),
      )
      watch.unref()
      const bodyRead = () => {
        lastActivity = performance.now()
      }
      const stopWatch = () => {
        clearInterval(watch)
        incoming.off('data', bodyRead)
      }
      outgoing.once('close', stopWatch)
      outgoing.once('finish', stopWatch)
      const listener = createRequestListener(
        (request) => {
          // Bun's socket.bytesRead does not advance for a streamed POST.
          // Remix has already attached its reader and owns pause/resume.
          if (request.body) incoming.on('data', bodyRead)
          return handler(request, socket.remoteAddress, idle)
        },
        {
          trustProxy: false,
          ...(options.publicProtocol
            ? { protocol: options.publicProtocol }
            : {}),
          onError(error) {
            console.error(
              JSON.stringify({
                event: 'transport.error',
                kind: error instanceof Error ? error.name : 'Unknown',
              }),
            )
          },
        },
      )
      return listener(incoming, outgoing)
    },
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.hostname, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('HTTP listen address unavailable')
  const hostname =
    address.family === 'IPv6' ? `[${address.address}]` : address.address
  let closed: Promise<void> | undefined
  function stop(force = false) {
    closing = true
    closed ??= new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    if (force) server.closeAllConnections()
    return closed
  }
  return { url: new URL(`http://${hostname}:${address.port}`), stop }
}
