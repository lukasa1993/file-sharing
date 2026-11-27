import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, type Fixture } from '../fixture.ts'

type SessionHeaders = Awaited<ReturnType<Fixture['signIn']>>
type Fields = Record<string, unknown>
const entriesUrl = '/_/api/v1/entries?mount=e2e'
const shareUrl = '/_/api/v1/shares'

function sessionCookie(response: Response) {
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0]
  if (!cookie) throw new Error('Missing session cookie')
  return cookie
}

async function csrf(response: Response) {
  const html = await response.text()
  const token = /<meta\b[^>]*name="csrf-token"[^>]*content="([^"]+)"/.exec(
    html,
  )?.[1]
  if (!token) throw new Error('Page did not render a CSRF token')
  return token
}

async function signIn(
  f: Fixture,
  username: string,
  password: string,
): Promise<SessionHeaders> {
  const form = await f.fetch('/login')
  // Chromium uses this policy to determine the Origin on a native form POST.
  expect(form.headers.get('referrer-policy')).toBe('same-origin')
  const auth = await f.fetch('/login', {
    method: 'POST',
    headers: { origin: f.origin, cookie: sessionCookie(form) },
    body: new URLSearchParams({ username, password, csrf: await csrf(form) }),
  })
  expect(auth.status).toBe(303)
  const cookie = sessionCookie(auth)
  const profile = await f.fetch('/_/account', { headers: { cookie } })
  expect(profile.status).toBe(200)
  return { origin: f.origin, cookie, 'X-CSRF-Token': await csrf(profile) }
}

function post(
  f: Fixture,
  path: string,
  session: SessionHeaders,
  fields: Fields,
) {
  return f.fetch(path, {
    method: 'POST',
    headers: { ...session, 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
}

async function manage(f: Fixture, owner: SessionHeaders, fields: Fields) {
  const response = await post(f, '/_/api/v1/admin', owner, fields)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
}

// Read the same principal IDs submitted by the rendered administration forms.
function principalId(html: string, label: string) {
  for (const option of html.matchAll(
    /<option value="([0-9a-f-]{36})">([^<]+)<\/option>/g,
  )) {
    if (option[2] === label && option[1]) return option[1]
  }
  throw new Error('Principal missing from the administration form: ' + label)
}

async function makeShare(
  f: Fixture,
  owner: SessionHeaders,
  file: string,
  fields: Fields,
) {
  const created = await post(f, shareUrl, owner, {
    targets: [{ mountId: 'e2e', segments: [file] }],
    mode: 'direct',
    ...fields,
  })
  expect(created.status).toBe(201)
  const share: { id: string } = await created.json()
  expect(typeof share.id).toBe('string')
  return share.id
}

async function activeDownload(
  f: Fixture,
  owner: SessionHeaders,
  actor: string,
) {
  const response = await f.fetch('/_/events', {
    headers: owner,
    signal: AbortSignal.timeout(8_000),
  })
  expect(response.status).toBe(200)
  if (!response.body) throw new Error('Missing transfer events')
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done)
        throw new Error(
          'Transfer events ended before the download state changed',
        )
      pending += chunk.value
      let delimiter = pending.indexOf('\n\n')
      while (delimiter !== -1) {
        const frame = pending.slice(0, delimiter)
        pending = pending.slice(delimiter + 2)
        const data = frame.split('\n').find((line) => line.startsWith('data: '))
        if (data) {
          const transfers: Array<{ kind: string; actor: string; id: string }> =
            JSON.parse(data.slice(6))
          const matching = transfers.find(
            (item) => item.kind === 'download' && item.actor === actor,
          )
          if (matching) return matching.id
        }
        delimiter = pending.indexOf('\n\n')
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

describe('account and sharing workflows over HTTP', () => {
  let f: Fixture
  let owner: SessionHeaders
  beforeAll(async () => {
    f = await fixture()
    owner = await f.signIn()
  })
  afterAll(async () => {
    await f?.close()
  })

  test('group grants become effective on sign-in and private homes stay private across the group', async () => {
    const home = 'personal'
    const password = crypto.randomUUID()
    await mkdir(join(f.storage, home))
    await writeFile(join(f.storage, home, 'draft.txt'), 'Personal draft\n')
    for (const username of ['account-sam', 'account-jo']) {
      await manage(f, owner, { action: 'createUser', username, password })
    }
    await manage(f, owner, { action: 'createGroup', name: 'Readers' })
    const admin = await f.fetch('/_/admin', { headers: owner })
    expect(admin.status).toBe(200)
    const html = await admin.text()
    const groupId = principalId(html, 'Readers')
    const samId = principalId(html, 'account-sam')
    const joId = principalId(html, 'account-jo')
    const original = await signIn(f, 'account-sam', password)
    expect((await f.fetch(entriesUrl, { headers: original })).status).toBe(403)
    for (const userId of [samId, joId]) {
      await manage(f, owner, {
        action: 'setMembership',
        userId,
        groupId,
        member: true,
      })
    }
    for (const permission of ['list', 'read']) {
      await manage(f, owner, {
        action: 'setGrant',
        subjectType: 'group',
        subjectId: groupId,
        mountId: 'e2e',
        path: '',
        permission,
        effect: 'allow',
      })
    }
    await manage(f, owner, {
      action: 'setHome',
      userId: samId,
      mountId: 'e2e',
      path: home,
    })
    expect((await f.fetch(entriesUrl, { headers: original })).status).toBe(401)
    const sam = await signIn(f, 'account-sam', password)
    const jo = await signIn(f, 'account-jo', password)
    const start = await f.fetch('/', { headers: sam })
    expect(start.status).toBe(303)
    expect(start.headers.get('location')).toBe(
      '/_/files?mount=e2e&path=personal',
    )
    const download = '/_/download?mount=e2e&path=personal%2Fdraft.txt'
    const ownFile = await f.fetch(download, { headers: sam })
    expect(ownFile.status).toBe(200)
    expect(ownFile.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await ownFile.text()).toBe('Personal draft\n')
    const common = await f.fetch(entriesUrl, { headers: jo })
    expect(common.status).toBe(200)
    const names = ((await common.json()) as Array<{ name: string }>).map(
      (item) => item.name,
    )
    expect(names).toContain('handoff.txt')
    expect(names).not.toContain(home)
    expect((await f.fetch(download, { headers: jo })).status).toBe(403)
    await manage(f, owner, {
      action: 'setEnabled',
      userId: joId,
      enabled: false,
    })
    expect((await f.fetch(entriesUrl, { headers: jo })).status).toBe(401)
  }, 15_000)

  test('a folder manager grants and withdraws access within their current directory permissions', async () => {
    const path = 'review-space'
    const password = crypto.randomUUID()
    await mkdir(join(f.storage, path))
    for (const name of ['agenda.txt', 'manager-only.txt', 'restricted.txt'])
      await writeFile(join(f.storage, path, name), name)
    for (const username of ['folder-manager', 'folder-reader'])
      await manage(f, owner, { action: 'createUser', username, password })
    await manage(f, owner, { action: 'createGroup', name: 'Review group' })
    const setup = await (await f.fetch('/_/admin', { headers: owner })).text()
    const managerId = principalId(setup, 'folder-manager')
    const readerId = principalId(setup, 'folder-reader')
    const groupId = principalId(setup, 'Review group')
    await manage(f, owner, {
      action: 'setMembership',
      userId: readerId,
      groupId,
      member: true,
    })
    const adminRule = (
      subjectId: string,
      permission: string,
      effect: string,
      target = path,
    ) =>
      manage(f, owner, {
        action: 'setGrant',
        subjectType: 'user',
        subjectId,
        mountId: 'e2e',
        path: target,
        permission,
        effect,
      })
    for (const right of ['manage', 'list', 'read'])
      await adminRule(managerId, right, 'allow')
    await adminRule(managerId, 'read', 'deny', path + '/manager-only.txt')
    await adminRule(readerId, 'read', 'deny', path + '/restricted.txt')
    const manager = await signIn(f, 'folder-manager', password)
    const reader = await signIn(f, 'folder-reader', password)
    const page = '/_/files?mount=e2e&path=' + path
    const editor = '/_/folder-permissions?mount=e2e&path=' + path
    const download = (name: string) =>
      f.fetch('/_/download?mount=e2e&path=' + path + '/' + name, {
        headers: reader,
      })
    const submit = (fields: Record<string, string>) =>
      f.fetch(editor, {
        method: 'POST',
        headers: { origin: f.origin, cookie: manager.cookie },
        body: new URLSearchParams({ ...fields, csrf: manager['X-CSRF-Token'] }),
      })
    const form = {
      operation: 'grant',
      subjectType: 'group',
      subjectId: groupId,
    }
    const grant = (permission: string) => submit({ ...form, permission })
    expect(await (await f.fetch(page, { headers: manager })).text()).toContain(
      'Manage folder permissions',
    )
    expect((await f.fetch(editor, { headers: reader })).status).toBe(403)
    expect((await f.fetch('/_/admin', { headers: manager })).status).toBe(403)
    expect(
      (await f.fetch('/_/folder-permissions?mount=e2e', { headers: manager }))
        .status,
    ).toBe(403)
    const empty = await (await f.fetch(editor, { headers: manager })).text()
    expect(empty).toContain('Grant folder access')
    expect(empty).not.toContain(groupId)
    expect(empty).not.toContain(readerId)
    const account = await (
      await f.fetch('/_/account', { headers: reader })
    ).text()
    expect(account).toContain(groupId)
    expect(account).toContain(readerId)
    expect((await grant('delete')).status).toBe(403)
    expect((await grant('manage')).status).toBe(400)
    expect(
      (
        await submit({
          ...form,
          subjectType: 'user',
          subjectId: managerId,
          permission: 'read',
        })
      ).status,
    ).toBe(400)
    expect((await grant('list')).status).toBe(303)
    const assigned = await f.fetch('/_/files', { headers: reader })
    expect(assigned.status).toBe(200)
    expect(await assigned.text()).toContain('agenda.txt')
    const accountGrant = {
      operation: 'grant',
      subjectType: 'user',
      subjectId: readerId,
      permission: 'read',
    }
    expect((await post(f, editor, owner, accountGrant)).status).toBe(303)
    expect(
      await (await f.fetch(editor, { headers: manager })).text(),
    ).not.toContain('folder-reader')
    expect(
      (await submit({ ...accountGrant, operation: 'withdraw' })).status,
    ).toBe(303)
    expect(await (await download('agenda.txt')).text()).toBe('agenda.txt')
    expect(
      (await post(f, editor, owner, { ...accountGrant, operation: 'withdraw' }))
        .status,
    ).toBe(303)
    expect((await download('agenda.txt')).status).toBe(403)
    expect((await grant('read')).status).toBe(303)
    expect(
      await (await f.fetch(editor, { headers: manager })).text(),
    ).toContain('Withdraw read for Review group')
    expect((await f.fetch(page, { headers: reader })).status).toBe(200)
    expect(await (await download('agenda.txt')).text()).toBe('agenda.txt')
    expect((await download('manager-only.txt')).status).toBe(403)
    expect((await download('restricted.txt')).status).toBe(403)
    expect(
      (await submit({ ...form, operation: 'withdraw', permission: 'read' }))
        .status,
    ).toBe(303)
    expect((await download('agenda.txt')).status).toBe(403)
    expect((await grant('read')).status).toBe(303)
    await adminRule(managerId, 'manage', 'remove')
    expect((await f.fetch(editor, { headers: manager })).status).toBe(401)
    const formerManager = await signIn(f, 'folder-manager', password)
    expect((await f.fetch(editor, { headers: formerManager })).status).toBe(403)
    expect((await download('agenda.txt')).status).toBe(403)
  }, 30_000)

  test('a guest password grant applies only to one share and session until the owner revokes it', async () => {
    const password = crypto.randomUUID()
    const first = await makeShare(f, owner, 'handoff.txt', {
      alias: 'private-first',
      access: 'password',
      password,
    })
    await makeShare(f, owner, 'handoff.txt', {
      alias: 'private-second',
      access: 'password',
      password,
    })
    const challenge = await f.fetch('/private-first')
    expect(challenge.status).toBe(401)
    const cookie = sessionCookie(challenge)
    const budget = spyOn(f.app.services.identity, 'consumePasswordAttempt')
    try {
      const unlocked = await f.fetch('/_/shares/' + first + '/unlock', {
        method: 'POST',
        headers: { cookie, origin: f.origin },
        body: new URLSearchParams({ password, csrf: await csrf(challenge) }),
      })
      expect(unlocked.status).toBe(303)
      expect(unlocked.headers.get('location')).toBe('/private-first')
      expect(budget).toHaveBeenCalledWith(
        expect.stringMatching(/^share:/),
        '127.0.0.1',
      )
    } finally {
      budget.mockRestore()
    }
    const firstFile = await f.fetch('/private-first', { headers: { cookie } })
    expect(firstFile.status).toBe(200)
    expect(await firstFile.text()).toBe('A real handoff\n')
    expect(
      (await f.fetch('/private-second', { headers: { cookie } })).status,
    ).toBe(401)
    expect((await f.fetch('/private-first')).status).toBe(401)
    const revoked = await f.fetch(shareUrl + '/' + first, {
      method: 'DELETE',
      headers: owner,
    })
    expect(revoked.status).toBe(204)
    expect(
      (await f.fetch('/private-first', { headers: { cookie } })).status,
    ).toBe(404)
  })

  test('a member’s upload and two independent downloads share their rate and quota accounting', async () => {
    const username = 'rate-member'
    const password = 'member-rate-test-password'
    await manage(f, owner, { action: 'createUser', username, password })
    const userId = principalId(
      await (await f.fetch('/_/admin', { headers: owner })).text(),
      username,
    )
    for (const permission of ['list', 'read', 'upload', 'create']) {
      await manage(f, owner, {
        action: 'setGrant',
        subjectType: 'user',
        subjectId: userId,
        mountId: 'e2e',
        path: '',
        permission,
        effect: 'allow',
      })
    }
    const member = await signIn(f, username, password)
    expect(
      (
        await post(f, '/_/api/v1/admin', member, {
          action: 'setBandwidth',
          userId,
          bytesPerSecond: '1',
        })
      ).status,
    ).toBe(403)
    await manage(f, owner, { action: 'setQuota', userId, bytes: 65536 })
    await manage(f, owner, {
      action: 'setBandwidth',
      userId,
      bytesPerSecond: 32768,
    })
    const body = Buffer.alloc(16384, 0x72)
    await writeFile(join(f.storage, 'rate-sample.bin'), body)
    const created = await f.fetch('/_/uploads', {
      method: 'POST',
      headers: {
        ...member,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(body.length),
        'Upload-Metadata':
          'mount ' +
          Buffer.from('e2e').toString('base64') +
          ',filename ' +
          Buffer.from('rate-upload.bin').toString('base64'),
      },
    })
    expect(created.status).toBe(201)
    const location = created.headers.get('Location')
    if (!location) throw new Error('Upload location missing')
    const adminPage = () =>
      f
        .fetch('/_/admin', { headers: owner })
        .then((response) => response.text())
    expect(await adminPage()).toContain('16 KB reserved')
    const download = async () => {
      const response = await f.fetch(
        '/_/download?mount=e2e&path=rate-sample.bin',
        { headers: member },
      )
      expect(response.status).toBe(200)
      return Buffer.from(await response.arrayBuffer())
    }
    const start = performance.now()
    const [left, right, upload] = await Promise.all([
      download(),
      download(),
      f.fetch(location, {
        method: 'PATCH',
        headers: {
          ...member,
          'Tus-Resumable': '1.0.0',
          'Upload-Offset': '0',
          'Content-Type': 'application/offset+octet-stream',
        },
        body,
      }),
    ])
    expect(left).toEqual(body)
    expect(right).toEqual(body)
    expect(upload.status).toBe(204)
    // 48 KiB divided by the single 32 KiB/s allowance, less its leading 125ms quantum.
    expect(performance.now() - start).toBeGreaterThanOrEqual(1300)
    const accountPage = await adminPage()
    expect(accountPage).toContain('16 KB used of 64 KB')
    expect(accountPage).not.toContain('16 KB reserved')
    await manage(f, owner, {
      action: 'setBandwidth',
      userId,
      bytesPerSecond: '',
    })
  }, 30000)

  test('transfer controls require administrator access and cancellation ends an active download', async () => {
    const password = crypto.randomUUID()
    await manage(f, owner, {
      action: 'createUser',
      username: 'transfer-viewer',
      password,
    })
    const viewer = await signIn(f, 'transfer-viewer', password)
    const filename = 'throttled.bin'
    const size = 256 * 1024
    await writeFile(join(f.storage, filename), Buffer.alloc(size, 1))
    const share = await makeShare(f, owner, filename, {
      alias: 'cancel-download',
      access: 'public',
      confirmPublic: true,
      bytesPerSecond: 8192,
    })
    const stop = new AbortController()
    let bytesReceived = 0
    const received = f
      .fetch('/cancel-download', { signal: stop.signal })
      .then(async (response) => {
        if (response.body)
          for await (const chunk of response.body)
            bytesReceived += chunk.byteLength
      })
      .catch(() => {})

    try {
      const actor = 'share:' + share
      const id = await activeDownload(f, owner, actor)
      const active = await f.fetch('/_/admin', { headers: owner })
      expect(await active.text()).toContain(id)
      const action = { action: 'cancelTransfer', id }
      expect((await post(f, '/_/api/v1/admin', viewer, action)).status).toBe(
        403,
      )
      await manage(f, owner, action)
      const deadline = performance.now() + 3_000
      let stillActive: boolean
      do {
        const admin = await f.fetch('/_/admin', { headers: owner })
        expect(admin.status).toBe(200)
        stillActive = (await admin.text()).includes(id)
        if (stillActive) await Bun.sleep(100)
      } while (stillActive && performance.now() < deadline)
      expect(stillActive).toBe(false)
      expect((await post(f, '/_/api/v1/admin', owner, action)).status).toBe(404)
      expect(bytesReceived).toBeLessThan(size)
    } finally {
      stop.abort()
      await received
    }
  }, 15_000)
})
