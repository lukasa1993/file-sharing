import { expect, test } from 'bun:test'
import { connect } from 'node:net'
import { listenHttp } from '../app/transport.ts'

const options = { hostname: '127.0.0.1', port: 0, idleTimeoutMs: 1000 }

function slowBody(chunks: number) {
  let count = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await Bun.sleep(100)
      controller.enqueue(Uint8Array.of(++count))
      if (count === chunks) controller.close()
    },
  })
}

test('steadily advancing response and request bodies outlive multiple idle periods', async () => {
  const count = 23
  const server = await listenHttp(options, async (request) => {
    if (request.method === 'POST')
      return new Response(await request.arrayBuffer())
    return new Response(slowBody(count), {
      headers: { 'Content-Length': String(count) },
    })
  })
  try {
    const [download, upload] = await Promise.all([
      fetch(server.url, { timeout: false }),
      fetch(server.url, {
        method: 'POST',
        body: slowBody(count),
        timeout: false,
      }),
    ])
    const expected = Uint8Array.from({ length: count }, (_, i) => i + 1)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(expected)
    expect(new Uint8Array(await upload.arrayBuffer())).toEqual(expected)
  } finally {
    await server.stop(true)
  }
}, 15000)

test('a client that stops reading a response releases its producer and connection', async () => {
  const released = Promise.withResolvers<void>()
  const block = new Uint8Array(64 * 1024)
  let produced = 0
  const server = await listenHttp(
    options,
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            produced += block.byteLength
            controller.enqueue(block)
          },
          cancel() {
            released.resolve()
          },
        }),
      ),
  )
  const client = connect({
    host: options.hostname,
    port: Number(server.url.port),
  })
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve)
      client.once('error', reject)
    })
    client.pause()
    client.write(
      'GET / HTTP/1.1\r\nHost: ' +
        server.url.host +
        '\r\nConnection: close\r\n\r\n',
    )
    const timeout = setTimeout(
      () => released.reject(new Error('Stalled client kept its producer')),
      10000,
    )
    try {
      await released.promise
    } finally {
      clearTimeout(timeout)
    }
    expect(produced).toBeGreaterThan(0)
    expect(produced).toBeLessThan(128 * 1024 ** 2)
  } finally {
    client.destroy()
    await server.stop(true)
  }
}, 15000)
