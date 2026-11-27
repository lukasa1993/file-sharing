import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
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
    const unlocked = await f.fetch('/_/shares/' + first + '/unlock', {
      method: 'POST',
      headers: { cookie, origin: f.origin },
      body: new URLSearchParams({ password, csrf: await csrf(challenge) }),
    })
    expect(unlocked.status).toBe(303)
    expect(unlocked.headers.get('location')).toBe('/private-first')
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
