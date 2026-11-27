import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { request, type ClientRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialize } from '../../scripts/ops.ts'

test('SIGTERM bounds the lifetime of an accepted request whose client stops sending the body', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fileserver-limited-drain-'))
  const state = join(directory, 'state')
  let processUnderTest: ReturnType<typeof Bun.spawn> | undefined
  let upload: ClientRequest | undefined
  try {
    await initialize(state, 'owner')
    const portProbe = createServer()
    await new Promise<void>((resolve, reject) => {
      portProbe.once('error', reject)
      portProbe.listen(0, '127.0.0.1', resolve)
    })
    const address = portProbe.address()
    if (!address || typeof address === 'string')
      throw new Error('Expected a TCP listener')
    await new Promise<void>((resolve, reject) =>
      portProbe.close((error) => (error ? reject(error) : resolve())),
    )
    const origin = 'http://127.0.0.1:' + address.port
    const config = join(state, 'config')
    const service = Bun.spawn(
      [process.execPath, join(import.meta.dir, '../../server.ts')],
      {
        env: {
          PATH: process.env.PATH,
          HOST: '127.0.0.1',
          PORT: String(address.port),
          PUBLIC_ORIGIN: origin,
          DATA_DIR: join(state, 'data'),
          CONFIG_FILE: join(config, 'mounts.json'),
          SESSION_SECRET_FILE: join(config, 'session.key'),
          BOOTSTRAP_FILE: join(config, 'bootstrap.json'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30000,
      },
    )
    processUnderTest = service
    const stdout = service.stdout.getReader()
    try {
      const first = await stdout.read()
      expect(new TextDecoder().decode(first.value)).toContain(
        '"event":"server.ready"',
      )
      upload = request(origin + '/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': 256,
          Expect: '100-continue',
          Origin: origin,
        },
      })
      const client = upload
      const accepted = new Promise<void>((resolve, reject) => {
        client.once('continue', resolve)
        client.once('error', reject)
        client.once('response', (response) => {
          response.resume()
          reject(
            new Error('Received final response before provisional Continue'),
          )
        })
      })
      const closed = new Promise<void>((resolve) =>
        client.once('close', resolve),
      )
      client.flushHeaders()
      await accepted
      await new Promise<void>((resolve, reject) =>
        client.write('username=', (error) =>
          error ? reject(error) : resolve(),
        ),
      )
      const start = performance.now()
      service.kill('SIGTERM')
      expect(await service.exited).toBe(0)
      await closed
      let rest = ''
      for (;;) {
        const chunk = await stdout.read()
        if (chunk.done) break
        rest += new TextDecoder().decode(chunk.value)
      }
      expect(rest).toContain('"event":"server.stopped"')
      console.log(
        JSON.stringify({
          bench: 'shutdown-with-incomplete-request',
          elapsedMs: Math.round(performance.now() - start),
        }),
      )
    } finally {
      stdout.releaseLock()
    }
  } finally {
    upload?.destroy()
    if (processUnderTest && processUnderTest.exitCode === null) {
      processUnderTest.kill('SIGKILL')
      await processUnderTest.exited
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 40000)
