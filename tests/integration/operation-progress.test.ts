import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { privateDir } from '../../app/filesystem/resolver.ts'
import { fixture, type Fixture } from '../fixture.ts'

type Event = {
  type: 'started' | 'progress' | 'result'
  id?: string
  bytes?: number
  total?: number
  phase?: 'copying' | 'verifying'
  status?: number
  result?: { results: { ok: boolean; error?: string }[] }
}
async function* events(response: Response) {
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader()
  if (!reader) throw new Error('Missing operation stream')
  let buffer = ''
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      buffer += part.value
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        yield JSON.parse(buffer.slice(0, newline)) as Event
        buffer = buffer.slice(newline + 1)
      }
    }
    expect(buffer).toBe('')
  } finally {
    reader.releaseLock()
  }
}

describe('cross-storage progress over native HTTP', () => {
  let f: Fixture, owner: Awaited<ReturnType<Fixture['signIn']>>
  beforeAll(async () => {
    f = await fixture({ copyStorage: true })
    owner = await f.signIn()
  }, 40000)
  afterAll(async () => {
    await f?.close()
  }, 15000)
  const path = '/_/api/v1/files/operations'
  const dest = { mountId: 'deliveries', segments: [] }
  const ref = (name: string) => ({ mountId: 'e2e', segments: [name] })
  function post(
    payload: Record<string, unknown>,
    headers = owner,
    signal?: AbortSignal,
  ) {
    return f.fetch(path, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      ...(signal ? { signal } : {}),
      body: JSON.stringify(payload),
    })
  }
  test('a completed copy returns the actual final result and publishes original bytes', async () => {
    const response = await post({
      operation: 'copy',
      refs: [ref('handoff.txt')],
      destination: dest,
      progress: true,
    })
    expect(response.status).toBe(200)
    const snapshots = await Array.fromAsync(events(response))
    expect(snapshots[0]?.type).toBe('started')
    expect(snapshots.at(-1)).toMatchObject({
      type: 'result',
      status: 200,
      result: {
        results: [
          {
            ok: true,
            result: { mountId: 'deliveries', segments: ['handoff.txt'] },
          },
        ],
      },
    })
    expect(
      await readFile(join(f.storage, '../deliveries/handoff.txt'), 'utf8'),
    ).toBe('A real handoff\n')
    expect(
      (await post({ operation: 'cancel', id: snapshots[0]?.id })).status,
    ).toBe(404)
  })
  test('an owner stops an in-flight move after partial progress and both the stage and registry are cleared', async () => {
    const name = 'source.bin',
      bytes = 256 * 1024 ** 2
    const handle = await open(join(f.storage, name), 'wx')
    try {
      await handle.truncate(bytes)
      await handle.write(Buffer.from('unique source'))
    } finally {
      await handle.close()
    }
    const credentials = {
      username: 'second-member',
      password: crypto.randomUUID(),
    }
    const created = await f.fetch('/_/api/v1/admin', {
      method: 'POST',
      headers: { ...owner, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'createUser', ...credentials }),
    })
    expect(created.ok).toBe(true)
    const member = await f.signIn(credentials)
    const response = await post({
      operation: 'move',
      refs: [ref(name)],
      destination: dest,
      progress: true,
    })
    expect(response.headers.get('Content-Type')).toContain(
      'application/x-ndjson',
    )
    let id = '',
      cancelled = false,
      last: Event | undefined
    for await (const event of events(response)) {
      if (event.type === 'started') id = event.id ?? ''
      if (
        event.type === 'progress' &&
        event.phase === 'copying' &&
        !cancelled
      ) {
        expect(event.bytes).toBeGreaterThan(0)
        expect(event.bytes).toBeLessThan(bytes)
        expect(event.total).toBe(bytes)
        expect((await post({ operation: 'cancel', id }, member)).status).toBe(
          404,
        )
        expect((await post({ operation: 'cancel', id })).status).toBe(204)
        cancelled = true
      }
      last = event
    }
    expect(cancelled).toBe(true)
    expect(last).toMatchObject({
      type: 'result',
      status: 409,
      result: { results: [{ ok: false }] },
    })
    expect(last?.result?.results[0]?.error).toContain('cancelled')
    expect((await stat(join(f.storage, name))).size).toBe(bytes)
    const source = await open(join(f.storage, name))
    try {
      const prefix = Buffer.alloc(13)
      await source.read(prefix)
      expect(prefix.toString()).toBe('unique source')
    } finally {
      await source.close()
    }
    expect(await readdir(join(f.storage, '../deliveries'))).not.toContain(name)
    expect(
      f.app.services.db.query('SELECT id FROM fs_copy_stages').all(),
    ).toEqual([])
    expect(
      await readdir(join(f.storage, '../deliveries', privateDir, 'stage')),
    ).toEqual([])
    expect(f.app.services.transfers.active()).toHaveLength(0)
  }, 40000)

  test('closing the streamed copy request releases its stage and leaves the original available', async () => {
    const name = 'disconnect.bin'
    const handle = await open(join(f.storage, name), 'wx')
    try {
      await handle.truncate(256 * 1024 ** 2)
    } finally {
      await handle.close()
    }
    const controller = new AbortController()
    const response = await post(
      {
        operation: 'copy',
        refs: [ref(name)],
        destination: dest,
        progress: true,
      },
      owner,
      controller.signal,
    )
    let interrupted = false
    for await (const event of events(response)) {
      if (event.type === 'progress' && event.bytes) {
        controller.abort()
        interrupted = true
        break
      }
    }
    expect(interrupted).toBe(true)
    // The listing waits for the operation's mount lock, including stage cleanup.
    const listing = await f.fetch('/_/api/v1/entries?mount=deliveries', {
      headers: owner,
    })
    expect(listing.status).toBe(200)
    expect(await listing.text()).not.toContain(name)
    expect((await stat(join(f.storage, name))).size).toBe(256 * 1024 ** 2)
    expect(
      await readdir(join(f.storage, '../deliveries', privateDir, 'stage')),
    ).toEqual([])
    expect(f.app.services.transfers.active()).toHaveLength(0)
  }, 40000)
})
