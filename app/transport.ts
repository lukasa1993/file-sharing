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
  options: { hostname: string; port: number },
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
      const idle = (preparing: boolean) =>
        incoming.setTimeout(preparing ? 0 : 120000)
      idle(false)
      const listener = createRequestListener(
        (request) => handler(request, incoming.socket.remoteAddress, idle),
        {
          trustProxy: false,
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
