import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, type Fixture } from '../fixture.ts'

describe('share options over HTTP', () => {
  let f: Fixture
  let owner: Awaited<ReturnType<Fixture['signIn']>>
  beforeAll(async () => {
    f = await fixture()
    owner = await f.signIn()
  })
  afterAll(async () => {
    await f?.close()
  })

  function save(fields: Record<string, unknown>, id?: string) {
    return f.fetch('/_/api/v1/shares' + (id ? '/' + id : ''), {
      method: id ? 'PATCH' : 'POST',
      headers: { ...owner, 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    })
  }
  test('simultaneous downloads of one URL share the owner’s bandwidth budget', async () => {
    const payload = Buffer.alloc(24 * 1024, 81)
    const name = 'audio.bin'
    await writeFile(join(f.storage, name), payload)
    const created = await save({
      targets: [{ mountId: 'e2e', segments: [name] }],
      access: 'public',
      confirmPublic: true,
      bytesPerSecond: payload.length,
    })
    expect(created.status).toBe(201)
    const share: { alias: string } = await created.json()
    const download = async () => {
      const response = await f.fetch('/' + share.alias)
      expect(response.status).toBe(200)
      return Buffer.from(await response.arrayBuffer())
    }
    const start = performance.now()
    const [a, b] = await Promise.all([download(), download()])
    const elapsed = performance.now() - start
    expect(a.equals(payload)).toBe(true)
    expect(b.equals(payload)).toBe(true)
    // Two seconds of shared bytes have one leading 125ms allowance for the alias.
    expect(elapsed).toBeGreaterThanOrEqual(1750)
  }, 12000)

  test('turning off latest-at-path pins the current replacement until the owner reconfirms it', async () => {
    const name = 'edition.txt'
    const file = join(f.storage, name)
    const publish = async (contents: string) => {
      const staging = file + '.new'
      await writeFile(staging, contents)
      await rename(staging, file)
    }
    await publish('first')
    const created = await save({
      targets: [{ mountId: 'e2e', segments: [name] }],
      access: 'public',
      confirmPublic: true,
    })
    expect(created.status).toBe(201)
    const share: { id: string; alias: string } = await created.json()
    const read = () => f.fetch('/' + share.alias)
    expect(await (await read()).text()).toBe('first')
    await publish('second')
    expect((await read()).status).toBe(404)
    const optIn = await save({ latestAtPath: true }, share.id)
    expect(optIn.status).toBe(200)
    expect(await (await read()).text()).toBe('second')
    await publish('third')
    expect(await (await read()).text()).toBe('third')
    const pin = await save({ latestAtPath: false }, share.id)
    expect(pin.status).toBe(200)
    expect(await (await read()).text()).toBe('third')
    await publish('fourth')
    expect((await read()).status).toBe(404)
  })
})
