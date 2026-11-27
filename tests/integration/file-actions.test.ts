import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResourceRef } from '../../app/contracts.ts'
import { fixture, type Fixture } from '../fixture.ts'

const ref = (...segments: string[]): ResourceRef => ({
  mountId: 'e2e',
  segments,
})
const operations = '/_/api/v1/files/operations'
const preferences = '/_/api/v1/preferences'
type OperationResult = {
  ref?: ResourceRef
  result?: ResourceRef | null
  id?: string
  ok: boolean
  status?: number
  skipped?: boolean
}

describe('file operations and preferences over HTTP', () => {
  let f: Fixture
  let owner: Awaited<ReturnType<Fixture['signIn']>>
  beforeAll(async () => {
    f = await fixture()
    owner = await f.signIn()
  })
  afterAll(async () => {
    await f?.close()
  })

  function post(path: string, fields: Record<string, unknown>) {
    return f.fetch(path, {
      method: 'POST',
      headers: { ...owner, 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    })
  }
  async function operate(fields: Record<string, unknown>, status = 200) {
    const response = await post(operations, fields)
    const body: { results: OperationResult[]; partial?: boolean } =
      await response.json()
    expect(response.status).toBe(status)
    return body
  }
  async function pageEntries(path: string, query: Record<string, string> = {}) {
    const res = await f.fetch(
      '/_/files?' + new URLSearchParams({ mount: 'e2e', path, ...query }),
      { headers: owner },
    )
    expect(res.status).toBe(200)
    const names: string[] = []
    await new HTMLRewriter()
      .on('input[data-select]', {
        element(el) {
          const label = el.getAttribute('aria-label')
          if (!label?.startsWith('Select '))
            throw new Error('Missing row label')
          names.push(label.slice('Select '.length))
        },
      })
      .transform(res)
      .text()
    return names
  }
  async function trashIds() {
    const res = await f.fetch('/_/trash', { headers: owner })
    expect(res.status).toBe(200)
    const ids: string[] = []
    await new HTMLRewriter()
      .on('button[data-trash-op="restore"]', {
        element(el) {
          const id = el.getAttribute('data-trash-id')
          if (!id) throw new Error('Missing trash ID')
          ids.push(id)
        },
      })
      .transform(res)
      .text()
    return ids
  }

  test('creates a folder and returns the actual destination for rename, copy and move collisions', async () => {
    for (const name of ['manuscript', 'delivery']) {
      const res = await post(operations, {
        operation: 'createDir',
        refs: [ref()],
        name,
      })
      expect(res.status).toBe(201)
      expect(await res.json()).toEqual({ ok: true })
    }
    expect(
      (
        await post(operations, {
          operation: 'createDir',
          refs: [ref()],
          name: 'delivery',
        })
      ).status,
    ).toBe(409)
    await writeFile(join(f.storage, 'manuscript', 'draft.txt'), 'original')
    const original = ref('manuscript', 'draft.txt'),
      renamed = ref('manuscript', 'final.txt')
    const rename = await operate({
      operation: 'rename',
      refs: [original],
      name: 'final.txt',
    })
    expect(rename.results).toEqual([
      { ref: original, ok: true, result: renamed },
    ])
    expect(
      await Bun.file(join(f.storage, 'manuscript', 'draft.txt')).exists(),
    ).toBe(false)
    const destination = ref('delivery')
    const copy = { operation: 'copy', refs: [renamed], destination }
    expect((await operate(copy)).results[0]?.result).toEqual(
      ref('delivery', 'final.txt'),
    )
    await writeFile(join(f.storage, 'delivery', 'final.txt'), 'other version')
    expect((await operate(copy, 409)).results[0]).toMatchObject({
      ok: false,
      status: 409,
    })
    expect(
      (await operate({ ...copy, conflict: 'skip' })).results[0],
    ).toMatchObject({ ok: true, result: null })
    expect(
      await readFile(join(f.storage, 'delivery', 'final.txt'), 'utf8'),
    ).toBe('other version')
    expect(
      (await operate({ ...copy, conflict: 'rename' })).results[0]?.result,
    ).toEqual(ref('delivery', 'final (2).txt'))
    expect(
      await readFile(join(f.storage, 'delivery', 'final (2).txt'), 'utf8'),
    ).toBe('original')
    expect(
      (
        await operate({
          operation: 'move',
          refs: [renamed],
          destination,
          conflict: 'overwrite',
        })
      ).results[0]?.result,
    ).toEqual(ref('delivery', 'final.txt'))
    expect(
      await readFile(join(f.storage, 'delivery', 'final.txt'), 'utf8'),
    ).toBe('original')
    expect(
      await Bun.file(join(f.storage, 'manuscript', 'final.txt')).exists(),
    ).toBe(false)
  })

  test('validates operation shapes before altering selected files and refuses to act on a storage root', async () => {
    const file = ref('handoff.txt')
    const invalid: Record<string, unknown>[] = [
      {
        operation: 'copy',
        refs: [file],
        destination: ref(),
        conflict: 'ignore',
      },
      { operation: 'restore', ids: [] },
      { operation: 'bulkRename', entries: 'handoff.txt' },
      { operation: 'bulkRename', entries: [{ ref: file }] },
      { operation: 'createDir', refs: [ref()] },
      { operation: 'createDir', refs: [ref()], name: '' },
      { operation: 'copy', refs: [file], destination: {} },
      { operation: 'rename', refs: [file, file], name: 'renamed.txt' },
      { operation: 'rename', refs: [], name: 'renamed.txt' },
      { operation: 'unknown', refs: [file] },
    ]
    for (const fields of invalid) {
      const response = await post(operations, fields)
      expect(response.status).toBe(400)
      expect((await response.json()).error.message).toBeTruthy()
    }
    const protectedRoot = await operate(
      { operation: 'delete', refs: [ref()] },
      400,
    )
    expect(protectedRoot.results).toMatchObject([
      { ok: false, ref: ref(), status: 400 },
    ])
    expect(await readFile(join(f.storage, 'handoff.txt'), 'utf8')).toBe(
      'A real handoff\n',
    )
  })
  test('reports per-item results for bulk rename and deletion, including partial completion', async () => {
    await mkdir(join(f.storage, 'edits'))
    for (const name of ['first.txt', 'second.txt', 'taken.txt'])
      await writeFile(join(f.storage, 'edits', name), name)
    const first = ref('edits', 'first.txt'),
      second = ref('edits', 'second.txt')
    const bulk = await operate(
      {
        operation: 'bulkRename',
        entries: [
          { ref: first, name: 'ready.txt' },
          { ref: second, name: 'taken.txt' },
        ],
      },
      207,
    )
    expect(bulk.partial).toBe(true)
    expect(bulk.results[0]).toMatchObject({
      ref: first,
      ok: true,
      result: ref('edits', 'ready.txt'),
    })
    expect(bulk.results[1]).toMatchObject({
      ref: second,
      ok: false,
      status: 409,
    })
    expect(await readFile(join(f.storage, 'edits', 'taken.txt'), 'utf8')).toBe(
      'taken.txt',
    )
    const removed = await operate(
      {
        operation: 'delete',
        refs: [ref('edits', 'ready.txt'), ref('edits', 'missing.txt')],
      },
      207,
    )
    expect(removed.partial).toBe(true)
    expect(removed.results[0]?.ok).toBe(true)
    expect(removed.results[1]).toMatchObject({ ok: false, status: 404 })
    expect(await pageEntries('edits')).toEqual(['second.txt', 'taken.txt'])
  })

  test('restores an occupied original path with explicit conflict policies and reports unavailable trash entries', async () => {
    await mkdir(join(f.storage, 'recovered'))
    const target = ref('recovered', 'quarter.txt')
    const original = join(f.storage, 'recovered', 'quarter.txt')
    await writeFile(original, 'older')
    const trashed = await operate(
      { operation: 'trash', refs: [target, ref('recovered', 'missing.txt')] },
      207,
    )
    expect(trashed.partial).toBe(true)
    expect(await pageEntries('recovered')).toEqual([])
    const [id] = await trashIds()
    if (!id) throw new Error('Trashed file missing from trash page')
    await writeFile(original, 'newer')
    await operate({ operation: 'restore', ids: [id] }, 409)
    const skipped = await operate({
      operation: 'restore',
      ids: [id],
      conflict: 'skip',
    })
    expect(skipped.results).toMatchObject([
      { id, ok: true, result: null, skipped: true },
    ])
    expect(await trashIds()).toContain(id)
    const missing = crypto.randomUUID()
    const restore = await operate(
      { operation: 'restore', ids: [id, missing], conflict: 'rename' },
      207,
    )
    expect(restore.partial).toBe(true)
    expect(restore.results[0]).toMatchObject({
      id,
      ok: true,
      result: ref('recovered', 'quarter (2).txt'),
    })
    expect(restore.results[1]).toMatchObject({
      id: missing,
      ok: false,
      status: 404,
    })
    expect(await readFile(original, 'utf8')).toBe('newer')
    expect(
      await readFile(join(f.storage, 'recovered', 'quarter (2).txt'), 'utf8'),
    ).toBe('older')
    expect(await trashIds()).not.toContain(id)
    await operate({ operation: 'restore', ids: [id] }, 404)
    await operate({ operation: 'trash', refs: [target] })
    const [purge] = await trashIds()
    if (!purge) throw new Error('Missing item to purge')
    const purged = await operate(
      { operation: 'purge', ids: [missing, purge] },
      207,
    )
    expect(purged.results[0]).toMatchObject({
      id: missing,
      ok: false,
      status: 404,
    })
    expect(purged.results[1]).toMatchObject({ id: purge, ok: true })
    expect(await trashIds()).toEqual([])
  })

  test('applies folder and recursive search, sorted pagination, favorites and recent folders', async () => {
    await mkdir(join(f.storage, 'catalog', 'subfolder'), { recursive: true })
    const files = Array.from(
      { length: 101 },
      (_, i) => 'note-' + String(i).padStart(3, '0') + '.txt',
    )
    await Promise.all(
      files.map((name) => writeFile(join(f.storage, 'catalog', name), 'x')),
    )
    await writeFile(
      join(f.storage, 'catalog', 'subfolder', 'note-leaf.txt'),
      'nested',
    )
    const catalog = ref('catalog')
    const listed = await f.fetch('/_/api/v1/entries?mount=e2e&path=catalog', {
      headers: owner,
    })
    expect(listed.status).toBe(200)
    const entries: Array<{ name: string; ref: ResourceRef }> =
      await listed.json()
    expect(entries).toHaveLength(102)
    expect(entries.every((entry) => entry.ref.segments.length === 2)).toBe(true)
    const settings = await post(preferences, {
      sort: 'name-desc',
      view: 'grid',
      theme: 'dark',
      favorite: catalog,
    })
    expect(settings.status).toBe(200)
    expect(await settings.json()).toMatchObject({
      sort: 'name-desc',
      view: 'grid',
      theme: 'dark',
      favorites: [catalog],
    })
    const page1 = await pageEntries('catalog', { q: 'NOTE-', page: '1' })
    expect(page1).toEqual(files.toReversed().slice(0, 100))
    expect(await pageEntries('catalog', { q: 'NOTE-', page: '2' })).toEqual([
      'note-000.txt',
    ])
    expect(
      await pageEntries('catalog', { q: 'leaf', scope: 'folder' }),
    ).toEqual([])
    expect(await pageEntries('catalog', { q: 'leaf', scope: 'tree' })).toEqual([
      'note-leaf.txt',
    ])
    await pageEntries('catalog/subfolder')
    const invalid = await post(preferences, { view: 'list', theme: 'unknown' })
    expect(invalid.status).toBe(400)
    const current = await f.fetch(preferences, { headers: owner })
    expect(current.status).toBe(200)
    const saved: { recents: ResourceRef[] } = await current.json()
    expect(saved).toMatchObject({ view: 'grid', favorites: [catalog] })
    expect(saved.recents.slice(0, 2)).toEqual([
      ref('catalog', 'subfolder'),
      catalog,
    ])
    const removed = await post(preferences, { removeFavorite: catalog })
    expect(removed.status).toBe(200)
    expect((await removed.json()).favorites).toEqual([])
  })
})
