import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, type Fixture } from '../fixture.ts'
import type { FileInfo, UploadSession } from '../../shared/transfers.ts'

let f: Fixture
let owner: Awaited<ReturnType<Fixture['signIn']>>
beforeAll(async () => {
  f = await fixture()
  owner = await f.signIn()
})
afterAll(() => f?.close())
function json(
  path: string,
  method: string,
  fields: unknown,
  headers: Record<string, string>,
) {
  return f.fetch(path, {
    method,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
}
async function create(fields: unknown, headers = owner) {
  const response = await json('/api/transfers/uploads', 'POST', fields, headers)
  expect(response.status).toBe(201)
  const session = (await response.json()) as UploadSession
  if (session.transport !== 'tus')
    throw new Error('Expected native TUS upload.')
  return session
}
function patch(
  url: string,
  body: string,
  headers: Record<string, string>,
  offset = 0,
) {
  return f.fetch(url, {
    method: 'PATCH',
    headers: {
      ...headers,
      'Tus-Resumable': '1.0.0',
      'Upload-Offset': String(offset),
      'Content-Type': 'application/offset+octet-stream',
    },
    body,
  })
}
function complete(id: string, headers = owner) {
  return json(
    '/api/transfers/uploads/' + id + '/complete',
    'POST',
    { parts: [] },
    headers,
  )
}
async function guest(alias: string) {
  const page = await f.fetch('/' + alias)
  expect(page.status).toBe(200)
  const cookie = page.headers.getSetCookie()[0]?.split(';')[0]
  const token = /<meta\b[^>]*name="csrf-token"[^>]*content="([^"]+)"/.exec(
    await page.text(),
  )?.[1]
  if (!cookie || !token) throw new Error('Missing recipient session.')
  return { origin: f.origin, cookie, 'X-CSRF-Token': token }
}
test('the common API creates one durable TUS reservation, returns the published file, and serves native range downloads', async () => {
  const input = {
    name: 'report ü.txt',
    size: 7,
    target: { mountId: 'e2e', segments: [] },
    idempotencyKey: 'report-retry',
  }
  const [session, retry] = await Promise.all([create(input), create(input)])
  expect(retry).toEqual(session)
  expect(session.chunkSize).toBe(f.app.services.transfers.limits.maxChunkBytes)
  expect(session.url).toBe('/_/uploads/' + session.id)
  expect(
    (
      await json(
        '/api/transfers/uploads',
        'POST',
        { ...input, name: 'another.txt' },
        owner,
      )
    ).status,
  ).toBe(409)
  expect((await complete(session.id)).status).toBe(409)
  expect(
    (
      await json(
        '/api/transfers/uploads/' + session.id + '/parts',
        'POST',
        { partNumber: 1 },
        owner,
      )
    ).status,
  ).toBe(409)
  expect((await patch(session.url, 'abc', owner)).status).toBe(204)
  const head = await f.fetch(session.url, {
    method: 'HEAD',
    headers: { ...owner, 'Tus-Resumable': '1.0.0' },
  })
  expect(head.headers.get('upload-offset')).toBe('3')
  expect((await patch(session.url, 'defg', owner, 3)).status).toBe(204)
  const finished = await complete(session.id)
  expect(finished.status).toBe(200)
  const file = (await finished.json()) as FileInfo
  expect(file).toMatchObject({
    name: input.name,
    size: input.size,
    expiresAt: null,
  })
  expect(await (await complete(session.id)).json()).toEqual(file)
  expect(
    await (
      await f.fetch('/api/transfers/files?mount=e2e', { headers: owner })
    ).json(),
  ).toMatchObject({ files: expect.arrayContaining([file]) })
  const redirect = await f.fetch(
    '/api/transfers/files/' + file.id + '/download',
    { headers: owner },
  )
  expect(redirect.status).toBe(303)
  expect(redirect.headers.get('Location')).toStartWith('/_/download?')
  const downloaded = await f.fetch(redirect.headers.get('Location')!, {
    headers: { ...owner, Range: 'bytes=2-4' },
  })
  expect(downloaded.status).toBe(206)
  expect(await downloaded.text()).toBe('cde')
  expect(
    (
      await f.fetch('/api/transfers/files/' + file.id, {
        method: 'DELETE',
        headers: owner,
      })
    ).status,
  ).toBe(204)
  expect(
    (
      await f.fetch('/api/transfers/files/' + file.id + '/download', {
        headers: owner,
      })
    ).status,
  ).toBe(404)
  expect(
    await (await f.fetch('/_/trash', { headers: owner })).text(),
  ).toContain(input.name)
}, 30000)
test('empty uploads finalize immediately, cancel stops incomplete work, and metadata writes need the native session CSRF', async () => {
  const empty = await create({ name: 'empty-common.bin', size: 0 })
  expect(await (await complete(empty.id)).json()).toMatchObject({
    name: 'empty-common.bin',
    size: 0,
  })
  const unfinished = await create({ name: 'unfinished.bin', size: 5 })
  expect(
    (
      await f.fetch('/api/transfers/uploads/' + unfinished.id, {
        method: 'DELETE',
        headers: owner,
      })
    ).status,
  ).toBe(204)
  expect((await complete(unfinished.id)).status).toBe(404)
  const unauth = await f.fetch('/api/transfers/files', {
    headers: { Accept: 'text/html' },
  })
  expect(unauth.status).toBe(401)
  expect(unauth.headers.get('content-type')).toContain('json')
  const missing = await json(
    '/api/transfers/uploads',
    'POST',
    { name: 'lost.txt', size: 0 },
    { cookie: owner.cookie, origin: f.origin },
  )
  expect(missing.status).toBe(403)
}, 30000)
test('guest upload requests preserve capability scope, the native collision policy and the published name', async () => {
  const folder = 'private-recipient-folder'
  const alias = 'common-drop'
  const name = 'photo.txt'
  await mkdir(join(f.storage, folder))
  await writeFile(join(f.storage, folder, name), 'original')
  const created = await json(
    '/_/api/v1/shares',
    'POST',
    {
      kind: 'upload',
      alias,
      access: 'public',
      confirmPublic: true,
      targets: [{ mountId: 'e2e', segments: [folder] }],
    },
    owner,
  )
  expect(created.status).toBe(201)
  const recipient = await guest(alias)
  const other = await guest(alias)
  const upload = await create({ requestAlias: alias, name, size: 3 }, recipient)
  expect(upload.url).toContain('?share=' + alias)
  expect((await patch(upload.url, 'new', other)).status).toBe(404)
  expect((await patch(upload.url, 'new', recipient)).status).toBe(204)
  const receipt = await complete(upload.id, recipient)
  expect(receipt.status).toBe(200)
  const details = (await receipt.json()) as FileInfo
  expect(details.name).not.toBe(name)
  expect(details.size).toBe(3)
  expect(details.id).toBe(upload.id)
  expect(await readFile(join(f.storage, folder, details.name), 'utf8')).toBe(
    'new',
  )
  expect(await readFile(join(f.storage, folder, name), 'utf8')).toBe('original')
  expect((await complete(upload.id, other)).status).toBe(404)
  expect(
    (
      await f.fetch('/api/transfers/files/' + details.id + '/download', {
        headers: recipient,
      })
    ).status,
  ).toBe(401)
}, 30000)

test('scoped API tokens retain their separate listing and reading permissions on common file URLs', async () => {
  async function token(scope: string) {
    const response = await json(
      '/_/api/v1/account',
      'POST',
      { action: 'issueToken', label: 'transfer ' + scope, scope, days: 1 },
      owner,
    )
    expect(response.status).toBe(200)
    const result = (await response.json()) as { token: string }
    return { Authorization: 'Bearer ' + result.token }
  }
  const listing = await token('list')
  const reading = await token('read')
  const files = await f.fetch('/api/transfers/files?mount=e2e', {
    headers: listing,
  })
  expect(files.status).toBe(200)
  const { files: items } = (await files.json()) as { files: FileInfo[] }
  const entry = items.find((file) => file.name === 'handoff.txt')
  if (!entry) throw new Error('Fixture handoff missing.')
  const url = '/api/transfers/files/' + entry.id + '/download'
  expect((await f.fetch(url, { headers: listing })).status).toBe(403)
  expect(
    (await f.fetch('/api/transfers/files?mount=e2e', { headers: reading }))
      .status,
  ).toBe(403)
  const redirect = await f.fetch(url, { headers: reading })
  expect(redirect.status).toBe(303)
  const bytes = await f.fetch(redirect.headers.get('Location')!, {
    headers: reading,
  })
  expect(await bytes.text()).toBe('A real handoff\n')
  expect(
    (
      await f.fetch('/api/transfers/files/' + entry.id, {
        method: 'DELETE',
        headers: reading,
      })
    ).status,
  ).toBe(403)
})

test('portable owner links address native recipients, enforce consent and exclude other owners even for administrators', async () => {
  const path = '/api/shares'
  const list = await f.fetch('/api/transfers/files', { headers: owner })
  const { files } = (await list.json()) as { files: FileInfo[] }
  const handoff = files.find((file) => file.name === 'handoff.txt')
  if (!handoff) throw new Error('Missing fixture file')
  expect(
    (await f.fetch(path, { headers: { Accept: 'text/html' } })).status,
  ).toBe(401)
  expect(
    (
      await json(
        path,
        'POST',
        { kind: 'file', fileId: handoff.id, access: 'public' },
        owner,
      )
    ).status,
  ).toBe(400)
  expect(
    (
      await json(
        path,
        'POST',
        { kind: 'file', fileId: handoff.id },
        { origin: f.origin, cookie: owner.cookie },
      )
    ).status,
  ).toBe(403)
  const made = await json(
    path,
    'POST',
    { kind: 'file', fileId: handoff.id, alias: 'portable-report' },
    owner,
  )
  expect(made.status).toBe(201)
  const link =
    (await made.json()) as import('../../shared/shares.ts').OwnerShare
  expect(link).toMatchObject({
    kind: 'file',
    href: '/portable-report',
    access: 'verified',
    fileId: handoff.id,
    createdAt: expect.any(Number),
    enabled: true,
    revoked: false,
  })
  expect((await f.fetch(link.href)).headers.get('location')).toBe(
    '/login?next=%2Fportable-report',
  )
  expect((await f.fetch(link.href, { headers: owner })).status).toBe(200)
  const second = { username: 'another-owner', password: crypto.randomUUID() }
  expect(
    (
      await json(
        '/_/api/v1/admin',
        'POST',
        { action: 'createUser', ...second, admin: true },
        owner,
      )
    ).status,
  ).toBe(200)
  const other = await f.signIn(second)
  expect(await (await f.fetch(path, { headers: other })).json()).toEqual({
    shares: [],
  })
  expect(
    (await f.fetch(path + '/' + link.id, { method: 'DELETE', headers: other }))
      .status,
  ).toBe(404)
  expect(await (await f.fetch(path, { headers: owner })).json()).toMatchObject({
    shares: expect.arrayContaining([link]),
  })
  expect(
    (await f.fetch(path + '/' + link.id, { method: 'DELETE', headers: owner }))
      .status,
  ).toBe(204)
  expect((await f.fetch(link.href, { headers: owner })).status).toBe(404)
}, 30000)

test('portable native upload requests use the provided folder or writable default and enforce password access', async () => {
  const path = '/api/shares',
    folder = 'portable-inbox'
  await mkdir(join(f.storage, folder))
  const fields = {
    kind: 'request',
    alias: 'portable-drop',
    access: 'public',
    confirmPublic: true,
    target: { mountId: 'e2e', segments: [folder] },
  }
  const made = await json(path, 'POST', fields, owner)
  expect(made.status).toBe(201)
  const link =
    (await made.json()) as import('../../shared/shares.ts').OwnerShare
  expect(link).toMatchObject({
    href: '/portable-drop',
    kind: 'request',
    access: 'public',
    fileId: null,
  })
  const recipient = await guest(link.alias)
  const session = await create(
    { name: 'thanks.txt', size: 3, requestAlias: link.alias },
    recipient,
  )
  expect((await patch(session.url, 'yes', recipient)).status).toBe(204)
  expect((await complete(session.id, recipient)).status).toBe(200)
  expect(await readFile(join(f.storage, folder, 'thanks.txt'), 'utf8')).toBe(
    'yes',
  )
  const defaultRequest = await json(
    path,
    'POST',
    { kind: 'request', access: 'password', password: crypto.randomUUID() },
    owner,
  )
  expect(defaultRequest.status).toBe(201)
  const locked =
    (await defaultRequest.json()) as import('../../shared/shares.ts').OwnerShare
  const passwordPage = await f.fetch(locked.href)
  expect(passwordPage.status).toBe(401)
  expect(await passwordPage.text()).toContain('Password required')
  const native = await f.fetch('/_/api/v1/shares/' + locked.id, {
    headers: owner,
  })
  expect(await native.json()).toMatchObject({
    targets: [{ mountId: 'e2e', segments: [] }],
  })
  expect(
    (await f.fetch(path + '/' + link.id, { method: 'DELETE', headers: owner }))
      .status,
  ).toBe(204)
  expect((await f.fetch(link.href, { headers: recipient })).status).toBe(404)
}, 30000)
