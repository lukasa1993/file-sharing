import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  link,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import {
  AppError,
  type Guard,
  type Mount,
  type ResourceRef,
} from '../app/contracts.ts'
import {
  Filesystem,
  FileStorage,
  fileStorageLayer,
} from '../app/filesystem/index.ts'
import {
  marker,
  privateDir,
  storageError,
  validateName,
} from '../app/filesystem/resolver.ts'

const allow: Guard = () => {}
const ref = (...segments: string[]): ResourceRef => ({
  mountId: 'home',
  segments,
})
const other = (...segments: string[]): ResourceRef => ({
  mountId: 'other',
  segments,
})
let storage: Filesystem,
  db: Database,
  base: string,
  home: string,
  mounts: Mount[]
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'fileserver-filesystem-'))
  home = join(base, 'home')
  mounts = [
    {
      id: 'home',
      label: 'Home',
      path: home,
      readOnly: false,
      sentinel: randomUUID(),
    },
    {
      id: 'other',
      label: 'Other',
      path: join(base, 'other'),
      readOnly: false,
      sentinel: randomUUID(),
    },
  ]
  for (const mount of mounts) {
    await mkdir(mount.path)
    await writeFile(join(mount.path, marker), mount.sentinel + '\n')
  }
  db = new Database(':memory:')
  storage = new Filesystem(mounts, db)
})
afterEach(async () => {
  db.close()
  await rm(base, { recursive: true, force: true })
})
async function stage(r: ResourceRef, bytes: string) {
  const id = randomUUID(),
    h = await storage.createStage(r, id, allow)
  try {
    await h.writeFile(bytes)
    await h.sync()
  } finally {
    await h.close()
  }
  return id
}

describe('mounted ordinary files', () => {
  test('reflects external changes, Unicode and scoped metadata immediately', async () => {
    await writeFile(join(home, '100% 雪.txt'), 'snow')
    await writeFile(join(home, 'private.txt'), 'private')
    const guard: Guard = (action, r) => {
      if (action === 'list' && r.segments.at(-1) === 'private.txt')
        throw new AppError(403, 'Hidden')
    }
    expect((await storage.list(ref(), guard)).map((e) => e.name)).toEqual([
      '100% 雪.txt',
    ])
    await rename(join(home, '100% 雪.txt'), join(home, 'renamed.txt'))
    expect(
      (await storage.search(ref(), 'NAMED', guard)).map((e) => e.name),
    ).toEqual(['renamed.txt'])
  })
  test('absent or wrong marker makes the root unavailable', async () => {
    await storage.list(ref(), allow)
    await writeFile(join(home, marker), 'different')
    await expect(storage.list(ref(), allow)).rejects.toMatchObject({
      status: 503,
    })
    await rm(join(home, marker))
    await expect(storage.space('home')).rejects.toMatchObject({ status: 503 })
  })
  test('disabled mounts persist across restarts and read-only roots reject creation', async () => {
    storage.setEnabled('home', false)
    await expect(
      new Filesystem(mounts, db).list(ref(), allow),
    ).rejects.toMatchObject({ status: 503 })
    storage.setEnabled('home', true)
    const ro = new Filesystem(
      mounts.map((m) => ({ ...m, readOnly: true })),
      db,
    )
    await expect(ro.createDir(ref('folder'), allow)).rejects.toMatchObject({
      status: 403,
    })
  })
  test('pinned open handles survive ordinary external replacement and scoped cleanup releases them', async () => {
    await writeFile(join(home, 'today'), 'yesterday')
    const file = await storage.openRead(ref('today'), allow)
    try {
      await writeFile(join(home, 'published'), 'today')
      await rename(join(home, 'published'), join(home, 'today'))
      expect(await file.handle.readFile('utf8')).toBe('yesterday')
    } finally {
      await file.handle.close()
    }
    const h = await Effect.runPromise(
      Effect.scoped(
        Effect.map(
          storage.openReadScoped(ref('today'), allow),
          (f) => f.handle,
        ),
      ),
    )
    await expect(h.stat()).rejects.toThrow()
  })
  test('a replacement folder invalidates a pinned share before reading its child', async () => {
    await storage.createDir(ref('folder'), allow)
    const pin = await storage.stat(ref('folder'), allow)
    await rename(join(home, 'folder'), join(home, 'previous'))
    await storage.createDir(ref('folder'), allow)
    await writeFile(join(home, 'folder', 'note'), 'replacement')
    const guard = Object.assign(() => {}, {
      targetPins: [{ ref: pin.ref, version: pin.version }],
    })
    await expect(
      storage.openRead(ref('folder', 'note'), guard),
    ).rejects.toMatchObject({ status: 404 })
  })
  test('omits linked and reserved entries and denies direct access', async () => {
    await writeFile(join(home, 'a'), 'content')
    await link(join(home, 'a'), join(home, 'b'))
    await symlink('a', join(home, 'shortcut'))
    await expect(storage.openRead(ref('a'), allow)).rejects.toMatchObject({
      status: 404,
    })
    await expect(
      storage.openRead(ref('shortcut'), allow),
    ).rejects.toMatchObject({ status: 404 })
    expect(await storage.list(ref(), allow)).toEqual([])
    await expect(storage.list(ref(privateDir), allow)).rejects.toMatchObject({
      status: 400,
    })
    await expect(storage.list(ref(marker), allow)).rejects.toMatchObject({
      status: 400,
    })
    await expect(storage.list(ref('..'), allow)).rejects.toMatchObject({
      status: 400,
    })
  })
})

describe('transfers and file operations', () => {
  test('publishes original bytes and checks the prior version on overwrite', async () => {
    const file = ref('nested', 'hello.txt'),
      id = await stage(file, 'original')
    expect(await storage.list(ref('nested'), allow)).toEqual([])
    let recorded = ''
    expect(
      await storage.commitStage(file, id, allow, 'reject', (_, identity) => {
        recorded = identity
      }),
    ).toEqual(file)
    expect(await storage.recoverStage(file, id, recorded)).toBe(true)
    const updateId = await stage(file, 'update'),
      old = await storage.stat(file, allow)
    await writeFile(join(home, 'nested', 'hello.txt'), 'external update')
    await expect(
      storage.commitStage(
        file,
        updateId,
        allow,
        'overwrite',
        undefined,
        old.version,
      ),
    ).rejects.toMatchObject({ status: 412 })
    expect(await readFile(join(home, 'nested', 'hello.txt'), 'utf8')).toBe(
      'external update',
    )
    await storage.discardStage('home', updateId)
  })
  test('concurrent publication selects one winner and preserves both payloads on rename', async () => {
    const out = ref('report.txt'),
      ids = [await stage(out, 'A'), await stage(out, 'B')]
    const outcomes = await Promise.allSettled(
      ids.map((id) => storage.commitStage(out, id, allow)),
    )
    expect(outcomes.filter((i) => i.status === 'fulfilled')).toHaveLength(1)
    const idx = outcomes.findIndex((i) => i.status === 'rejected'),
      remaining = ids[idx]
    if (!remaining) throw new Error('Expected one pending upload')
    expect(await storage.commitStage(out, remaining, allow, 'rename')).toEqual(
      ref('report (2).txt'),
    )
    expect(await readFile(join(home, 'report (2).txt'), 'utf8')).toBe(
      idx === 0 ? 'A' : 'B',
    )
  })
  test('recursive permission failure preserves source and destination', async () => {
    await storage.createDir(ref('folder'), allow)
    await writeFile(join(home, 'folder', 'note'), 'secret')
    const deny: Guard = (action, r) => {
      if (r.segments.includes('note') && action === 'copy')
        throw new AppError(403, 'no copy')
    }
    await expect(
      storage.operate('copy', ref('folder'), other('copied'), deny),
    ).rejects.toMatchObject({
      status: 403,
    })
    expect(await storage.list(other(), allow)).toEqual([])
    expect(await readFile(join(home, 'folder', 'note'), 'utf8')).toBe('secret')
  })
  test('cross-root move publishes a complete directory, and trash restores to a nonconflicting path', async () => {
    await storage.createDir(ref('folder'), allow)
    await writeFile(join(home, 'folder', 'note'), 'copied')
    await storage.operate('move', ref('folder'), other('folder'), allow)
    expect(await storage.list(ref(), allow)).toEqual([])
    expect(await readFile(join(base, 'other', 'folder', 'note'), 'utf8')).toBe(
      'copied',
    )
    await storage.operate('trash', other('folder'), null, allow)
    const record = storage.trash(allow)[0]
    if (!record) throw new Error('Expected a trash record')
    await storage.createDir(other('folder'), allow)
    await expect(storage.restore(record.id, allow)).rejects.toMatchObject({
      status: 409,
    })
    expect(await storage.restore(record.id, allow, 'rename')).toEqual(
      other('folder (2)'),
    )
    expect(
      await readFile(join(base, 'other', 'folder (2)', 'note'), 'utf8'),
    ).toBe('copied')
    expect(storage.trash(allow)).toEqual([])
  })
})

describe('publication and recovery contracts', () => {
  test('a file move interrupted between link and unlink converges on the published destination', async () => {
    await writeFile(join(home, 'source'), 'durable')
    const expected = await storage.stat(ref('source'), allow)
    const id = randomUUID()
    db.query('INSERT INTO fs_publications VALUES(?,?,?,?,?,?,NULL)').run(
      id,
      'home',
      'entry',
      '["source"]',
      '["dest"]',
      expected.version.split(':').slice(0, 2).join(':'),
    )
    await link(join(home, 'source'), join(home, 'dest'))
    const restarted = new Filesystem(mounts, db)
    expect(
      (await restarted.list(ref(), allow)).map((item) => item.name),
    ).toEqual(['dest'])
    expect(await readFile(join(home, 'dest'), 'utf8')).toBe('durable')
    expect(db.query('SELECT id FROM fs_publications').all()).toEqual([])
  })
  test('recovers a staged upload whose destination link became durable before cleanup', async () => {
    const file = ref('uploaded'),
      id = await stage(file, 'durable')
    const h = await storage.openStage('home', id)
    const s = await h.stat({ bigint: true })
    await h.close()
    const staged = join(home, privateDir, 'stage', id)
    await link(staged, join(home, 'uploaded'))
    expect(await storage.recoverStage(file, id, s.dev + ':' + s.ino)).toBe(true)
    expect(await readFile(join(home, 'uploaded'), 'utf8')).toBe('durable')
    expect(await storage.recoverStage(file, id, '0:0')).toBe(false)
    await expect(storage.openStage('home', id)).rejects.toMatchObject({
      status: 404,
    })
  })
  test('failed publication callback preserves the stage for retry', async () => {
    const file = ref('draft'),
      id = await stage(file, 'recover me')
    await expect(
      storage.commitStage(file, id, allow, 'reject', () => {
        throw new Error('injected persistence failure')
      }),
    ).rejects.toThrow()
    expect(await storage.list(ref(), allow)).toEqual([])
    expect(await storage.commitStage(file, id, allow)).toEqual(file)
  })
  test('replacing a pinned upload destination prevents publication or recreation', async () => {
    await storage.createDir(ref('inbox'), allow)
    const pin = await storage.stat(ref('inbox'), allow)
    const target = ref('inbox', 'new'),
      id = await stage(target, 'bytes')
    const guard = Object.assign(() => {}, {
      targetPins: [{ ref: pin.ref, version: pin.version }],
    })
    await rename(join(home, 'inbox'), join(home, 'renamed'))
    await expect(storage.commitStage(target, id, guard)).rejects.toMatchObject({
      status: 404,
    })
    expect((await storage.list(ref(), allow)).map((ent) => ent.name)).toEqual([
      'renamed',
    ])
    await storage.discardStage('home', id)
  })
  test('skip never replaces existing bytes and conditional overwrite requires modify permission', async () => {
    const file = ref('existing')
    await writeFile(join(home, 'existing'), 'old')
    expect(
      await storage.commitStage(file, await stage(file, 'skip'), allow, 'skip'),
    ).toBeNull()
    const guard: Guard = (action) => {
      if (action === 'modify') throw new AppError(403, 'read only')
    }
    const id = await stage(file, 'new')
    await expect(
      storage.commitStage(file, id, guard, 'overwrite'),
    ).rejects.toMatchObject({ status: 403 })
    expect(await readFile(join(home, 'existing'), 'utf8')).toBe('old')
    const original = await storage.stat(file, allow)
    expect(
      await storage.commitStage(
        file,
        id,
        allow,
        'overwrite',
        undefined,
        original.version,
      ),
    ).toEqual(file)
    expect(await readFile(join(home, 'existing'), 'utf8')).toBe('new')
  })
  test('copy preserves source, same-root rename retains identity, delete removes only the selected entry', async () => {
    const file = ref('first')
    await writeFile(join(home, 'first'), 'test')
    const first = await storage.stat(file, allow)
    expect(
      await storage.operate('rename', file, ref('renamed'), allow),
    ).toEqual(ref('renamed'))
    const renamed = await storage.stat(ref('renamed'), allow)
    expect(renamed.version.split(':').slice(0, 2)).toEqual(
      first.version.split(':').slice(0, 2),
    )
    expect(
      await storage.operate('copy', ref('renamed'), ref('copy'), allow),
    ).toEqual(ref('copy'))
    expect(
      await storage.operate('copy', ref('renamed'), ref('copy'), allow, 'skip'),
    ).toBeNull()
    await storage.operate('delete', ref('renamed'), null, allow)
    expect(await readFile(join(home, 'copy'), 'utf8')).toBe('test')
    expect((await storage.list(ref(), allow)).map((ent) => ent.name)).toEqual([
      'copy',
    ])
  })
  test('cancelled bulk copy leaves both roots unchanged', async () => {
    await writeFile(join(home, 'initial'), 'bytes')
    const cancel = new AbortController()
    cancel.abort()
    expect(() =>
      storage.operate(
        'copy',
        ref('initial'),
        other('copy'),
        allow,
        'reject',
        cancel.signal,
      ),
    ).toThrow()
    expect(await storage.list(other(), allow)).toEqual([])
    expect(await readFile(join(home, 'initial'), 'utf8')).toBe('bytes')
  })
  test('only authorized trash appears and per-root retention controls cleanup', async () => {
    await writeFile(join(home, 'old'), 'old')
    await writeFile(join(base, 'other', 'keep'), 'keep')
    await storage.operate('trash', ref('old'), null, allow)
    await storage.operate('trash', other('keep'), null, allow)
    expect(storage.trashRetention('home')).toBeNull()
    storage.setTrashRetention('home', 0)
    expect(storage.trashRetention('home')).toBe(0)
    expect(
      storage.trash((_act, r) => {
        if (r.mountId === 'other') throw new AppError(403, 'denied')
      }),
    ).toHaveLength(1)
    await storage.collectTrash(86_400_000)
    expect(storage.trash(allow).map((item) => item.ref)).toEqual([
      other('keep'),
    ])
    storage.setTrashRetention('other', null)
    expect(storage.trashRetention('other')).toBeNull()
    expect(() => storage.trashRetention('missing')).toThrow('Unknown storage')
    await storage.collectTrash(0)
    expect(storage.trash(allow)).toEqual([])
  })
})

describe('batch editing', () => {
  test('bulk rename reports each outcome and preserves conflicting targets', async () => {
    await writeFile(join(home, 'one'), 'a')
    await writeFile(join(home, 'two'), 'b')
    await writeFile(join(home, 'busy'), 'keep')
    const results = await storage.bulkRename(
      [
        { ref: ref('one'), name: 'open' },
        { ref: ref('two'), name: 'busy' },
      ],
      allow,
    )
    expect(results.map((r) => r.ok)).toEqual([true, false])
    expect(await readFile(join(home, 'open'), 'utf8')).toBe('a')
    expect(await readFile(join(home, 'two'), 'utf8')).toBe('b')
    expect(await readFile(join(home, 'busy'), 'utf8')).toBe('keep')
  })
  test('rejects a rename cycle before any item changes', async () => {
    await writeFile(join(home, 'a'), 'original')
    await expect(
      storage.bulkRename(
        [
          { ref: ref('a'), name: 'b' },
          { ref: ref('b'), name: 'a' },
        ],
        allow,
      ),
    ).rejects.toMatchObject({ status: 409 })
    expect(await readFile(join(home, 'a'), 'utf8')).toBe('original')
  })
})

describe('scopes and retention', () => {
  test('recursive search admits accounts separately and refreshes its per-minute budget', async () => {
    await writeFile(join(home, 'field-notes'), 'notes')
    const exercise = Effect.gen(function* () {
      for (let i = 0; i < 12; i++)
        yield* storage.searchTask(ref(), 'field', allow, 'reader-a')
      const exhausted = yield* Effect.flip(
        storage.searchTask(ref(), 'field', allow, 'reader-a'),
      )
      expect(exhausted.status).toBe(429)
      expect(
        yield* storage.searchTask(ref(), 'field', allow, 'reader-b'),
      ).toHaveLength(1)
      yield* TestClock.adjust(60_000)
      expect(
        yield* storage.searchTask(ref(), 'field', allow, 'reader-a'),
      ).toHaveLength(1)
    }).pipe(Effect.provide(TestClock.layer()))
    await Effect.runPromise(exercise)
  })
  test('recursive scans have separate admission and release it when access fails', async () => {
    await writeFile(join(home, 'field-notes'), 'notes')
    const a = storage.search(ref(), 'field', allow, 'reader-a')
    const b = storage.search(ref(), 'field', allow, 'reader-b')
    const sameActor = storage.search(ref(), 'field', allow, 'reader-a')
    const third = storage.search(ref(), 'field', allow, 'reader-c')
    const [first, second, duplicate, full] = await Promise.allSettled([
      a,
      b,
      sameActor,
      third,
    ])
    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('fulfilled')
    for (const refused of [duplicate, full]) {
      expect(refused).toMatchObject({
        status: 'rejected',
        reason: { status: 429 },
      })
    }
    const denied: Guard = () => {
      throw new AppError(403, 'Not allowed')
    }
    await expect(
      storage.search(ref(), 'field', denied, 'reader-a'),
    ).rejects.toMatchObject({ status: 403 })
    expect(
      await storage.search(ref(), 'field', allow, 'reader-a'),
    ).toHaveLength(1)
  })
  test('a test storage Layer uses a deterministic clock at the retention boundary', async () => {
    await writeFile(join(home, 'expired'), 'bytes')
    await storage.operate('trash', ref('expired'), null, allow)
    const item = storage.trash(allow)[0]
    if (!item) throw new Error('Missing trashed fixture')
    const program = Effect.gen(function* () {
      const fs = yield* FileStorage
      yield* TestClock.setTime(item.deletedAt + 999)
      yield* fs.collectTrashTask(1000)
      const before = fs.trash(allow)
      yield* TestClock.adjust(1)
      yield* fs.collectTrashTask(1000)
      return { before, after: fs.trash(allow) }
    }).pipe(
      Effect.provide(
        Layer.merge(fileStorageLayer(mounts, db), TestClock.layer()),
      ),
    )
    const { before, after } = await Effect.runPromise(program)
    expect(before).toHaveLength(1)
    expect(after).toEqual([])
  })
  test('scoped descriptors release on failure and repeated failed opens do not poison later reads', async () => {
    await writeFile(join(home, 'ok'), 'present')
    let opened: Awaited<ReturnType<Filesystem['openRead']>> | undefined
    const operation = Effect.gen(function* () {
      opened = yield* storage.openReadScoped(ref('ok'), allow)
      return yield* Effect.fail(new AppError(409, 'injected consumer failure'))
    })
    await Effect.runPromise(Effect.scoped(Effect.result(operation)))
    if (!opened) throw new Error('Missing acquired file')
    await expect(opened.handle.stat()).rejects.toThrow()
    for (let i = 0; i < 3; i++)
      await expect(
        storage.openRead(ref('absent'), allow),
      ).rejects.toMatchObject({ status: 404 })
    expect((await storage.stat(ref('ok'), allow)).size).toBe(7)
  })
})

describe('storage failure boundaries', () => {
  test('storage errors report a useful status without host paths', () => {
    for (const [code, status] of Object.entries({
      ENOENT: 404,
      ENOTDIR: 404,
      ELOOP: 404,
      EEXIST: 409,
      ENOTEMPTY: 409,
      EACCES: 403,
      EPERM: 403,
      EROFS: 403,
      ENOSPC: 507,
      EDQUOT: 507,
      EXDEV: 409,
      ENOTSUP: 409,
      EOPNOTSUPP: 409,
      EIO: 503,
    })) {
      const err = storageError(
        Object.assign(new Error('operation on /private/volume/root failed'), {
          code,
        }),
      )
      expect(err.status).toBe(status)
      expect(err.message).not.toContain('/private')
    }
    const denied = new AppError(403, 'Not permitted')
    expect(storageError(denied)).toBe(denied)
  })
  test('preserves valid Unicode names and bounds paths by UTF-8 bytes and component count', async () => {
    for (const name of [
      'percent%23.txt',
      ' space #?.txt',
      'e\u0301',
      '\u00e9',
      'a'.repeat(255),
    ])
      expect(() => validateName(name)).not.toThrow()
    for (const name of [
      '',
      '.',
      'a/b',
      'a\\b',
      'bad\u0000name',
      '雪'.repeat(86),
      '\ud800',
    ])
      expect(() => validateName(name)).toThrow()
    await expect(
      storage.list(ref(...Array<string>(97).fill('a')), allow),
    ).rejects.toMatchObject({ status: 400 })
  })
  test('an internal area with permissive access prevents staging', async () => {
    await mkdir(join(home, privateDir))
    await chmod(join(home, privateDir), 0o755)
    await expect(
      storage.createStage(ref('example'), randomUUID(), allow),
    ).rejects.toMatchObject({ status: 503 })
    expect(await storage.list(ref(), allow)).toEqual([])
  })
  test('invalid filename bytes in an existing directory stay out of the listing', async () => {
    const path = Buffer.concat([Buffer.from(home + '/'), Buffer.from([0xff])])
    await writeFile(path, 'foreign')
    await writeFile(join(home, 'safe'), 'safe')
    expect((await storage.list(ref(), allow)).map((e) => e.name)).toEqual([
      'safe',
    ])
  })
  test('a marker copied into a different root cannot revive a replaced mount', async () => {
    const mount = mounts[0]
    if (!mount) throw new Error('Missing test mount')
    await storage.list(ref(), allow)
    await rename(home, home + '-retired')
    await mkdir(home)
    await writeFile(join(home, marker), mount.sentinel)
    await expect(storage.list(ref(), allow)).rejects.toMatchObject({
      status: 503,
    })
  })
  test('initialization rejects overlapping paths, duplicate IDs and missing markers', () => {
    const m = mounts[0]
    if (!m) throw new Error('Missing test mount')
    expect(
      () =>
        new Filesystem(
          [m, { ...m, id: 'child', path: join(m.path, 'sub') }],
          db,
        ),
    ).toThrow()
    expect(
      () => new Filesystem([m, { ...m, path: join(base, 'elsewhere') }], db),
    ).toThrow()
    expect(() => new Filesystem([{ ...m, sentinel: '  ' }], db)).toThrow()
    expect(() => new Filesystem([{ ...m, path: '/' }], db)).toThrow()
  })
})
describe('recovery around directory mutations', () => {
  test.each([
    ['entry', 'invalid json'],
    ['entry', 'null'],
    ['entry', '[42]'],
    ['entry', '[]'],
    ['entry', '[".fileserver-root"]'],
    ['unknown', '["src"]'],
    ['stage', '["invalid-id"]'],
    ['trash', '["parent","child"]'],
  ])(
    'invalid journal location %s %s blocks only its mount',
    async (area, source) => {
      await writeFile(join(home, 'ordinary.txt'), 'keep')
      db.query('INSERT INTO fs_publications VALUES(?,?,?,?,?,?,NULL)').run(
        randomUUID(),
        'home',
        area,
        source,
        '["ordinary.txt"]',
        '0:0',
      )
      await expect(storage.list(ref(), allow)).rejects.toMatchObject({
        status: 503,
      })
      expect(await storage.list(other(), allow)).toEqual([])
      expect(await readFile(join(home, 'ordinary.txt'), 'utf8')).toBe('keep')
    },
  )
  test.each([false, true])(
    'cleans only its own empty directory reservation (occupied=%s)',
    async (occupied) => {
      await storage.createDir(ref('src'), allow)
      await storage.createDir(ref('reserved'), allow)
      if (occupied)
        await writeFile(join(home, 'reserved', 'external.txt'), 'new data')
      const src = await storage.stat(ref('src'), allow),
        reservation = await storage.stat(ref('reserved'), allow)
      const inode = (v: string) => v.split(':').slice(0, 2).join(':')
      db.query('INSERT INTO fs_publications VALUES(?,?,?,?,?,?,?)').run(
        randomUUID(),
        'home',
        'entry',
        '["src"]',
        '["reserved"]',
        inode(src.version),
        inode(reservation.version),
      )
      const restarted = new Filesystem(mounts, db)
      const names = (await restarted.list(ref(), allow))
        .map((e) => e.name)
        .sort()
      expect(names).toEqual(occupied ? ['reserved', 'src'] : ['src'])
      if (occupied)
        expect(
          await readFile(join(home, 'reserved', 'external.txt'), 'utf8'),
        ).toBe('new data')
      expect(db.query('SELECT id FROM fs_publications').all()).toEqual([])
    },
  )
  test('unpublished copy data and interrupted trash transitions recover on next open', async () => {
    await writeFile(join(home, 'trashed'), 'bytes')
    await storage.operate('trash', ref('trashed'), null, allow)
    const [item] = storage.trash(allow)
    if (!item) throw new Error('Missing fixture')
    const copyId = await stage(ref('never-visible'), 'partial')
    db.query('INSERT INTO fs_copy_stages VALUES(?,?)').run(copyId, 'home')
    db.query("UPDATE fs_trash SET state='moving' WHERE id=?").run(item.id)
    db.query('INSERT INTO fs_trash VALUES(?,?,?,?,?,?)').run(
      randomUUID(),
      'home',
      '["unmoved"]',
      1,
      'moving',
      '0:0',
    )
    const restarted = new Filesystem(mounts, db)
    expect(await restarted.list(ref(), allow)).toEqual([])
    await expect(restarted.openStage('home', copyId)).rejects.toMatchObject({
      status: 404,
    })
    expect(restarted.trash(allow)).toEqual([item])
    expect(await restarted.restore(item.id, allow)).toEqual(ref('trashed'))
    expect(await readFile(join(home, 'trashed'), 'utf8')).toBe('bytes')
  })
  test('overwrite can replace a file but refuses a populated directory', async () => {
    await writeFile(join(home, 'first'), 'first')
    await writeFile(join(home, 'second'), 'second')
    expect(
      await storage.operate(
        'move',
        ref('first'),
        ref('second'),
        allow,
        'overwrite',
      ),
    ).toEqual(ref('second'))
    expect(await readFile(join(home, 'second'), 'utf8')).toBe('first')
    await storage.createDir(ref('keep'), allow)
    await writeFile(join(home, 'keep', 'child'), 'retained')
    await expect(
      storage.operate('move', ref('second'), ref('keep'), allow, 'overwrite'),
    ).rejects.toMatchObject({ status: 409 })
    expect(await readFile(join(home, 'keep', 'child'), 'utf8')).toBe('retained')
    expect(await readFile(join(home, 'second'), 'utf8')).toBe('first')
  })
})

describe('tracked upload retirement', () => {
  async function track(file: ResourceRef) {
    const entry = await storage.stat(file, allow)
    const [dev, ino, , , , birth] = entry.version.split(':')
    if (!birth || BigInt(birth) <= 0n)
      throw new Error('Fixture filesystem must expose creation time')
    const id = [dev, ino, birth].join(':')
    db.query('INSERT INTO fs_tracked_files(mount,identity) VALUES(?,?)').run(
      file.mountId,
      id,
    )
    return id
  }
  function state(id: string) {
    return db
      .query<{ state: string }, [string]>(
        'SELECT state FROM fs_tracked_files WHERE identity=?',
      )
      .get(id)?.state
  }
  test('trash and restore retain charges, and deleting the renamed file confirms its exact identity', async () => {
    await writeFile(join(home, 'document'), 'bytes')
    const id = await track(ref('document'))
    await storage.operate('trash', ref('document'), null, allow)
    const item = storage.trash(allow)[0]
    if (!item) throw new Error('Missing trash fixture')
    expect(state(id)).toBe('live')
    await storage.restore(item.id, allow)
    await storage.operate('rename', ref('document'), ref('renamed'), allow)
    expect(state(id)).toBe('live')
    await storage.operate('delete', ref('renamed'), null, allow)
    expect(state(id)).toBe('deleted')
    expect(await storage.list(ref(), allow)).toEqual([])
  })
  test('purging a folder retires its tracked descendants without claiming untracked objects', async () => {
    const dir = join(home, 'folder')
    await mkdir(join(dir, 'sub'), { recursive: true })
    for (const name of ['first', 'second', 'untracked'])
      await writeFile(join(dir, 'sub', name), name)
    const first = await track(ref('folder', 'sub', 'first')),
      second = await track(ref('folder', 'sub', 'second'))
    await storage.operate('trash', ref('folder'), null, allow)
    const item = storage.trash(allow)[0]
    if (!item) throw new Error('Missing trash fixture')
    expect(state(first)).toBe('live')
    await storage.purgeTrash(item.id, allow)
    expect(state(first)).toBe('deleted')
    expect(state(second)).toBe('deleted')
    expect(db.query('SELECT count(*) FROM fs_tracked_files').values()).toEqual([
      [2],
    ])
  })
  test.each([
    ['moving', false, true, 'live'],
    ['moving', true, true, 'live'],
    ['moving', true, false, 'deleted'],
    ['retired', true, false, 'deleted'],
    ['retired', false, false, 'deleted'],
  ] as const)(
    'reconciles %s with witness=%s and original=%s',
    async (phase, witness, sourcePresent, expected) => {
      const original = join(home, 'document')
      await writeFile(original, 'bytes')
      const id = await track(ref('document')),
        name = randomUUID()
      const stage = join(home, privateDir, 'stage')
      await mkdir(stage, { recursive: true, mode: 0o700 })
      const anchor = join(stage, name)
      if (witness) await link(original, anchor)
      if (!sourcePresent) await rm(original)
      db.query(
        "UPDATE fs_tracked_files SET state=?,stage=?,area='entry',parent='[]' WHERE identity=?",
      ).run(phase, name, id)
      const fs = new Filesystem(mounts, db)
      expect((await fs.list(ref(), allow)).map((entry) => entry.name)).toEqual(
        sourcePresent ? ['document'] : [],
      )
      expect(state(id)).toBe(expected)
      await expect(readFile(anchor)).rejects.toMatchObject({ code: 'ENOENT' })
      if (sourcePresent) expect(await readFile(original, 'utf8')).toBe('bytes')
    },
  )
  test('a changed witness is kept for inspection and cannot credit an unrelated file', async () => {
    await writeFile(join(home, 'keep'), 'bytes')
    const id = await track(ref('keep')),
      name = randomUUID()
    const stage = join(home, privateDir, 'stage')
    await mkdir(stage, { recursive: true, mode: 0o700 })
    await writeFile(join(stage, name), 'different')
    db.query(
      "UPDATE fs_tracked_files SET state='moving',stage=?,area='entry',parent='[]' WHERE identity=?",
    ).run(name, id)
    await expect(storage.list(ref(), allow)).rejects.toMatchObject({
      status: 503,
    })
    expect(state(id)).toBe('moving')
    expect(await readFile(join(stage, name), 'utf8')).toBe('different')
    expect(await readFile(join(home, 'keep'), 'utf8')).toBe('bytes')
  })
})

describe('ordinary storage and conflict boundaries', () => {
  test('resolves root metadata and rejects invalid read handles without exhausting later reads', async () => {
    const root = await Effect.runPromise(storage.statTask(ref(), allow))
    expect(root).toMatchObject({ name: 'Home', kind: 'directory', ref: ref() })
    await expect(storage.openRead(ref(), allow)).rejects.toMatchObject({
      status: 409,
    })
    await expect(storage.openRead(ref(''), allow)).rejects.toMatchObject({
      status: 400,
    })
    await expect(storage.space('gone')).rejects.toMatchObject({ status: 404 })
    expect(() => storage.setEnabled('gone', true)).toThrow('Unknown storage')
    expect(() => storage.discardStage('home', 'invalid')).toThrow(
      'Invalid operation ID',
    )
    await writeFile(join(home, 'next'), 'bytes')
    const file = await storage.openRead(ref('next'), allow)
    try {
      expect(await file.handle.readFile('utf8')).toBe('bytes')
    } finally {
      await file.handle.close()
    }
  })
  test('filename search skips unlisted subtrees and a file removed by a host writer during refresh', async () => {
    const publicDir = join(home, 'public'),
      privateDir = join(home, 'denied')
    await mkdir(publicDir)
    await mkdir(privateDir)
    await writeFile(join(publicDir, 'target.txt'), 'visible')
    await writeFile(join(privateDir, 'target.txt'), 'hidden')
    await writeFile(join(home, 'target-old.txt'), 'obsolete')
    const guard: Guard = (action, file) => {
      if (action !== 'list') return
      if (file.segments.includes('denied')) throw new AppError(403, 'denied')
      if (file.segments.at(-1) === 'target-old.txt')
        rmSync(join(home, 'target-old.txt'))
    }
    expect(
      (await storage.search(ref(), 'TARGET', guard)).map((e) => e.ref),
    ).toEqual([ref('public', 'target.txt')])
    for (const query of ['  ', 's'.repeat(257)])
      expect(() => storage.search(ref(), query, allow)).toThrow(
        'Enter a filename search',
      )
    await expect(
      storage.list(ref(), (action, r) => {
        if (action === 'list' && r.segments.length)
          throw new AppError(503, 'Rules unavailable')
      }),
    ).rejects.toMatchObject({ status: 503, message: 'Rules unavailable' })
  })
  test('a changed pinned file fails closed and can be reopened with a fresh grant', async () => {
    const file = ref('report.txt')
    await writeFile(join(home, 'report.txt'), 'draft')
    const original = await storage.stat(file, allow)
    const grant = Object.assign(() => {}, {
      targetPins: [{ ref: file, version: original.version }],
    })
    await writeFile(join(home, 'report.txt'), 'published')
    await expect(storage.openRead(file, grant)).rejects.toMatchObject({
      status: 404,
    })
    expect((await storage.stat(file, allow)).size).toBe(9)
  })
  test('saturated mount queues reject excess work and recover admission once the queue drains', async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 264 }, () => storage.stat(ref(), allow)),
    )
    const full = outcomes.filter(
      (item) =>
        item.status === 'rejected' &&
        item.reason instanceof AppError &&
        item.reason.status === 503 &&
        item.reason.message === 'Storage is busy',
    )
    expect(full.length).toBeGreaterThan(0)
    expect(outcomes.some((row) => row.status === 'fulfilled')).toBe(true)
    expect((await storage.stat(ref(), allow)).kind).toBe('directory')
  })
  test('invalid move destinations and ambiguous batches leave every original name unchanged', async () => {
    await storage.createDir(ref('project'), allow)
    const doc = ref('project', 'doc')
    await writeFile(join(home, 'project', 'doc'), 'bytes')
    expect(() => storage.operate('copy', doc, null, allow)).toThrow(
      'Destination required',
    )
    expect(() => storage.operate('move', ref('project'), doc, allow)).toThrow(
      'Choose a separate destination',
    )
    expect(() => storage.operate('rename', doc, other('doc'), allow)).toThrow(
      'original directory',
    )
    expect(() =>
      storage.operate('rename', doc, ref('elsewhere'), allow),
    ).toThrow('original directory')
    const same = { ref: doc, name: 'doc' }
    for (const batch of [
      [],
      Array.from({ length: 257 }, () => same),
      [same, same],
      [same, { ref: ref('project', 'other'), name: 'doc' }],
    ])
      await expect(storage.bulkRename(batch, allow)).rejects.toMatchObject({
        status: 400,
      })
    expect(await storage.bulkRename([same], allow)).toEqual([
      { ...same, ok: true, result: doc },
    ])
    const cancelled = await storage.bulkRename(
      [{ ref: doc, name: 'rename' }],
      allow,
      'reject',
      AbortSignal.abort(),
    )
    expect(cancelled).toMatchObject([{ ok: false, status: 409 }])
    expect(await readFile(join(home, 'project', 'doc'), 'utf8')).toBe('bytes')
  })
  test('an overwrite must target a regular file and a conditional edit requires an existing version', async () => {
    const target = ref('project'),
      id = await stage(target, 'draft')
    await storage.createDir(target, allow)
    await expect(
      storage.commitStage(target, id, allow, 'overwrite'),
    ).rejects.toMatchObject({ status: 409 })
    await storage.operate('delete', target, null, allow)
    await expect(
      storage.commitStage(
        target,
        id,
        allow,
        'overwrite',
        undefined,
        'missing-version',
      ),
    ).rejects.toMatchObject({ status: 412 })
    expect(await storage.commitStage(target, id, allow)).toEqual(target)
  })
  test('restore skip and overwrite respect a replacement file and retain trash until completion', async () => {
    await writeFile(join(home, 'draft'), 'original')
    await storage.operate('trash', ref('draft'), null, allow)
    const item = storage.trash(allow)[0]
    if (!item) throw new Error('Missing fixture')
    await writeFile(join(home, 'draft'), 'replacement')
    expect(await storage.restore(item.id, allow, 'skip')).toBeNull()
    await expect(
      storage.restore(
        item.id,
        (action) => {
          if (action === 'modify') throw new AppError(403, 'Read only')
        },
        'overwrite',
      ),
    ).rejects.toMatchObject({ status: 403 })
    expect(await readFile(join(home, 'draft'), 'utf8')).toBe('replacement')
    expect(storage.trash(allow)).toEqual([item])
    expect(await storage.restore(item.id, allow, 'overwrite')).toEqual(
      ref('draft'),
    )
    expect(await readFile(join(home, 'draft'), 'utf8')).toBe('original')
  })
  test('a missing or replaced trash object is never restored or purged by mistake', async () => {
    await writeFile(join(home, 'draft'), 'original')
    await storage.operate('trash', ref('draft'), null, allow)
    const item = storage.trash(allow)[0]
    if (!item) throw new Error('Missing fixture')
    const path = join(home, privateDir, 'trash', item.id)
    await rename(path, path + '-previous')
    await expect(storage.restore(item.id, allow)).rejects.toMatchObject({
      status: 409,
    })
    await writeFile(path, 'replacement')
    await expect(storage.purgeTrash(item.id, allow)).rejects.toMatchObject({
      status: 409,
    })
    expect(await readFile(path, 'utf8')).toBe('replacement')
    db.query("UPDATE fs_trash SET state='moving' WHERE id=?").run(item.id)
    await expect(storage.list(ref(), allow)).rejects.toMatchObject({
      status: 503,
    })
  })
  test('rejects unknown or invalid retention and bounds very large trash listings', async () => {
    expect(() => storage.setTrashRetention('absent', 0)).toThrow(
      'Unknown storage',
    )
    expect(() => storage.setTrashRetention('home', -1)).toThrow(
      'Invalid trash retention',
    )
    await expect(storage.collectTrash(-1)).rejects.toMatchObject({
      status: 400,
    })
    db.exec(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<20001)
      INSERT INTO fs_trash(id,mount,path,deleted,state,identity) SELECT CAST(n AS TEXT),'home','["old"]',n,'trashed','0:1' FROM seq`)
    expect(() => storage.trash(allow)).toThrow('Trash listing limit exceeded')
  })
})

describe('cross-mount copies under ordinary contention', () => {
  test.each(['shorter', 'same length', 'after verification'] as const)(
    'host edit (%s) keeps the destination unchanged and cleans private copy state',
    async (moment) => {
      const source = join(home, 'draft'),
        target = join(base, 'other', 'draft')
      await writeFile(source, 'initial')
      await writeFile(target, 'keep')
      let edited = false
      const guard: Guard = (action, file) => {
        if (action !== 'read' || file.mountId !== 'home' || edited) return
        const stage = db
          .query<{ id: string }, []>('SELECT id FROM fs_copy_stages LIMIT 1')
          .get()
        if (!stage) return
        const temporary = join(base, 'other', privateDir, 'stage', stage.id)
        if ((moment === 'after verification') !== existsSync(temporary)) return
        edited = true
        writeFileSync(source, moment === 'shorter' ? 'x' : 'revised')
        utimesSync(source, new Date(2020, 0, 1), new Date(2020, 0, 1))
      }
      await expect(
        storage.operate(
          'copy',
          ref('draft'),
          other('draft'),
          guard,
          'overwrite',
        ),
      ).rejects.toMatchObject({
        status: 409,
        message: 'Source changed during copy',
      })
      expect(edited).toBe(true)
      expect(await readFile(target, 'utf8')).toBe('keep')
      expect(await readFile(source, 'utf8')).toBe(
        moment === 'shorter' ? 'x' : 'revised',
      )
      expect(db.query('SELECT * FROM fs_copy_stages').all()).toEqual([])
    },
  )

  test('cancellation after staging starts releases the staged copy without publishing it', async () => {
    await writeFile(join(home, 'draft'), 'unchanged')
    const controller = new AbortController()
    const guard: Guard = (action) => {
      if (
        action === 'read' &&
        db.query('SELECT id FROM fs_copy_stages LIMIT 1').get()
      )
        controller.abort()
    }
    await expect(
      storage.operate(
        'copy',
        ref('draft'),
        other('published'),
        guard,
        'reject',
        controller.signal,
      ),
    ).rejects.toMatchObject({ status: 409 })
    expect(await storage.list(other(), allow)).toEqual([])
    expect(await readFile(join(home, 'draft'), 'utf8')).toBe('unchanged')
    expect(db.query('SELECT * FROM fs_copy_stages').all()).toEqual([])
  })
  test('verified cross-mount move reports incomplete deletion when the source grant changes', async () => {
    const target = join(base, 'other', 'result')
    await writeFile(join(home, 'draft'), 'verified bytes')
    await expect(
      storage.operate('move', ref('draft'), other('result'), (action, file) => {
        if (
          action === 'delete' &&
          file.mountId === 'home' &&
          existsSync(target)
        )
          throw new AppError(403, 'Grant changed')
      }),
    ).rejects.toMatchObject({
      status: 409,
      message:
        'Destination copied and verified. Source removal was incomplete.',
    })
    expect(await readFile(target, 'utf8')).toBe('verified bytes')
    expect(await readFile(join(home, 'draft'), 'utf8')).toBe('verified bytes')
  })
  test('explicit cross-root overwrite checks destination modification rights before publication', async () => {
    await writeFile(join(home, 'draft'), 'source')
    await writeFile(join(base, 'other', 'saved'), 'old')
    const checked: string[] = []
    const result = await storage.operate(
      'copy',
      ref('draft'),
      other('saved'),
      (action, file) => {
        if (action === 'modify')
          checked.push(file.mountId + '/' + file.segments.join('/'))
      },
      'overwrite',
    )
    expect(result).toEqual(other('saved'))
    expect(checked).toEqual(['other/saved', 'other/saved'])
    expect(await readFile(join(base, 'other', 'saved'), 'utf8')).toBe('source')
    expect(await readFile(join(home, 'draft'), 'utf8')).toBe('source')
  })
})

describe('late operation outcomes', () => {
  test('a host edit between recursive inventory and deletion preserves the revised file', async () => {
    const file = join(home, 'record')
    await writeFile(file, 'original')
    let updated = false
    await expect(
      storage.operate('delete', ref('record'), null, (action) => {
        if (action === 'delete' && !updated) {
          updated = true
          writeFileSync(file, 'new contents from host')
        }
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: 'Entry changed during operation',
    })
    expect(await readFile(file, 'utf8')).toBe('new contents from host')
  })
  test.each(['before inventory', 'before publication'] as const)(
    'cancelled cross-root copy (%s) leaves the original name and file intact',
    async (when) => {
      const source = ref('draft'),
        dest = other('published'),
        controller = new AbortController()
      await writeFile(join(home, 'draft'), 'original bytes')
      const guard: Guard = (action, file) => {
        if (
          when === 'before inventory' &&
          action === 'create' &&
          file.mountId === 'other' &&
          file.segments.length
        )
          controller.abort()
        if (when !== 'before publication' || action !== 'read') return
        const copy = db
          .query<{ id: string }, []>('SELECT id FROM fs_copy_stages LIMIT 1')
          .get()
        if (
          copy &&
          existsSync(join(base, 'other', privateDir, 'stage', copy.id))
        )
          controller.abort()
      }
      await expect(
        storage.operate(
          'copy',
          source,
          dest,
          guard,
          'reject',
          controller.signal,
        ),
      ).rejects.toMatchObject({
        status: 409,
        message: 'Operation cancelled before publication',
      })
      expect(await storage.list(other(), allow)).toEqual([])
      expect(await readFile(join(home, 'draft'), 'utf8')).toBe('original bytes')
    },
  )
  test('upload recovery preserves the current final file and an independent unfinished stage', async () => {
    const target = ref('published'),
      file = join(home, 'published')
    await writeFile(file, 'published')
    const version = (await storage.stat(target, allow)).version
    const identity = version.split(':').slice(0, 2).join(':')
    const id = await stage(target, 'unpublished')
    expect(await storage.recoverStage(target, id, identity)).toBe(false)
    await link(file, join(home, 'host-copy'))
    expect(await storage.recoverStage(target, id, identity)).toBe(false)
    const staged = await storage.openStage('home', id)
    try {
      expect(await staged.readFile('utf8')).toBe('unpublished')
    } finally {
      await staged.close()
    }
    expect(await readFile(file, 'utf8')).toBe('published')
    expect(await readFile(join(home, 'host-copy'), 'utf8')).toBe('published')
  })
  test('a directory occupying a staged-file slot cannot be published or discarded as a file', async () => {
    const target = ref('draft'),
      id = await stage(target, 'fixture')
    const slot = join(home, privateDir, 'stage', id)
    await rm(slot)
    await mkdir(slot)
    await expect(storage.commitStage(target, id, allow)).rejects.toMatchObject({
      status: 409,
      message: 'Invalid upload stage',
    })
    await expect(storage.discardStage('home', id)).rejects.toThrow()
    expect(await storage.list(ref(), allow)).toEqual([])
  })
  test('purge forgets the row if the host already removed that trash item', async () => {
    await writeFile(join(home, 'removed'), 'content')
    await storage.operate('trash', ref('removed'), null, allow)
    const item = storage.trash(allow)[0]
    if (!item) throw new Error('Missing trash fixture')
    await rm(join(home, privateDir, 'trash', item.id))
    await storage.purgeTrash(item.id, allow)
    expect(storage.trash(allow)).toEqual([])
  })
  test('keep-both reports exhaustion when every permitted numbered name already exists', async () => {
    await writeFile(join(home, 'original.txt'), 'new')
    const directory = join(base, 'other')
    for (let first = 1; first <= 1000; first += 32) {
      const names = Array.from(
        { length: Math.min(32, 1001 - first) },
        (_, index) => first + index,
      )
      await Promise.all(
        names.map((n) =>
          writeFile(
            join(directory, n === 1 ? 'kept.txt' : 'kept (' + n + ').txt'),
            'existing',
          ),
        ),
      )
    }
    await expect(
      storage.operate(
        'copy',
        ref('original.txt'),
        other('kept.txt'),
        allow,
        'rename',
      ),
    ).rejects.toMatchObject({ status: 409, message: 'No available filename' })
    expect(await readFile(join(directory, 'kept.txt'), 'utf8')).toBe('existing')
    expect(await readFile(join(directory, 'kept (1000).txt'), 'utf8')).toBe(
      'existing',
    )
    expect(await readFile(join(home, 'original.txt'), 'utf8')).toBe('new')
  })
})
