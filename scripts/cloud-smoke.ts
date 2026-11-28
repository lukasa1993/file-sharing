import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { verifyCloudCapacity } from '../tests/cloudflare/quota-smoke'
import { partBytes } from '../shared/transfers'

async function mail(spool: string, email: string) {
  for (let attempt = 0; attempt < 55; attempt++) {
    for (const file of await readdir(spool)) {
      if (!file.endsWith('.json')) continue
      const message = JSON.parse(await readFile(join(spool, file), 'utf8'))
      if (
        message.to === email &&
        message.subject === 'Your lshare sign-in code'
      ) {
        const code = /\b[0-9]{8}\b/.exec(message.text)?.[0]
        if (code) return code
      }
    }
    await delay(180)
  }
  throw new Error(
    'The local Email Service simulator did not deliver the verification code.',
  )
}

export async function smoke(
  app: string,
  s3: string,
  spool: string,
  checkCapacity: boolean,
) {
  const email = 'smoke@example.test'
  const jar = new Map<string, string>()
  async function api(
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
    expectedStatus?: number,
  ) {
    const response = await fetch(app + path, {
      method,
      redirect: 'manual',
      headers: {
        Origin: app,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Cookie: [...jar].map(([key, value]) => key + '=' + value).join('; '),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const line of response.headers.getSetCookie()) {
      const cookie = line.split(';')[0]!,
        i = cookie.indexOf('=')
      jar.set(cookie.slice(0, i), cookie.slice(i + 1))
    }
    if (expectedStatus !== undefined)
      assert.equal(response.status, expectedStatus)
    else if (!response.ok && response.status !== 303)
      throw new Error(
        'Smoke metadata ' +
          method +
          ' ' +
          path +
          ' returned ' +
          response.status +
          '.',
      )
    return response
  }
  await api('/api/auth/start', { email })
  await api('/api/auth/verify', { email, code: await mail(spool, email) })
  for (const size of [0, partBytes + 11]) {
    const name = size ? 'two-parts.bin' : 'empty.bin'
    const bytes = Buffer.alloc(size, 0xa5)
    if (size) bytes.write('final bytes', size - 11)
    const upload = await (
      await api('/api/transfers/uploads', { name, size })
    ).json()
    assert.equal(upload.transport, 'multipart')
    assert.equal(upload.partSize, partBytes)
    const parts = []
    for (let n = 0; n < Math.max(1, Math.ceil(size / partBytes)); n++) {
      const partNumber = n + 1
      const signed = await (
        await api('/api/transfers/uploads/' + upload.id + '/parts', {
          partNumber,
        })
      ).json()
      assert.equal(new URL(signed.url).origin, s3)
      const preflight = await fetch(signed.url, {
        method: 'OPTIONS',
        headers: {
          Origin: app,
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'content-type',
        },
      })
      assert.ok(preflight.ok, 'Storage must accept a CORS preflight.')
      assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), app)
      const response = await fetch(signed.url, {
        method: 'PUT',
        headers: { Origin: app },
        body: bytes.subarray(n * partBytes, (n + 1) * partBytes),
      })
      if (!response.ok)
        throw new Error(
          'Direct S3 part returned ' +
            response.status +
            ' ' +
            ((await response.text()).match(/<Code>([^<]+)<\/Code>/)?.[1] ?? ''),
        )
      assert.match(
        response.headers.get('Access-Control-Expose-Headers') ?? '',
        /\betag\b/i,
      )
      const etag = response.headers.get('ETag')
      assert.ok(etag)
      parts.push({ partNumber, etag })
    }
    const file = await (
      await api('/api/transfers/uploads/' + upload.id + '/complete', { parts })
    ).json()
    assert.equal(file.size, size)
    const replay = await (
      await api('/api/transfers/uploads/' + upload.id + '/complete', { parts })
    ).json()
    assert.equal(replay.id, file.id)
    const grant = await api('/api/transfers/files/' + file.id + '/download')
    assert.equal(grant.status, 303)
    const url = grant.headers.get('Location')
    assert.ok(url && new URL(url).origin === s3)
    const received = await fetch(url)
    assert.equal(received.status, 200)
    assert.deepEqual(Buffer.from(await received.arrayBuffer()), bytes)
    if (size) {
      const partial = await fetch(url, { headers: { Range: 'bytes=-11' } })
      assert.equal(partial.status, 206)
      assert.equal(await partial.text(), 'final bytes')
    }
    await api('/api/transfers/files/' + file.id, undefined, 'DELETE')
    const deleted = await fetch(url)
    assert.equal(deleted.status, 404)
    await deleted.body?.cancel()
  }
  if (checkCapacity) await verifyCloudCapacity(api, spool)
  const tick = await fetch(
    app +
      '/cdn-cgi/handler/scheduled?cron=' +
      encodeURIComponent('*/5 * * * *'),
  )
  if (!tick.ok)
    throw new Error('Scheduled maintenance returned ' + tick.status + '.')
  await tick.body?.cancel()
  console.log(
    'Verified native email login, empty and two-part direct transfers, byte ranges, deletion and scheduled maintenance.',
  )
}
