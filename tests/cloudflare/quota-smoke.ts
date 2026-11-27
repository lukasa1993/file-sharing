import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

type Api = (
  path: string,
  body?: unknown,
  method?: string,
  expectedStatus?: number,
) => Promise<Response>

async function capturedAlerts(spool: string) {
  const messages: string[] = []
  for (const file of await readdir(spool)) {
    if (!file.endsWith('.json')) continue
    const mail = JSON.parse(await readFile(join(spool, file), 'utf8'))
    if (
      mail.to === 'ops@example.test' &&
      mail.subject === 'lshare capacity alert'
    ) {
      messages.push(mail.text)
    }
  }
  return messages
}

export async function verifyCloudCapacity(api: Api, spool: string) {
  const uploads = '/api/transfers/uploads'
  const maxFile = 100_000_000
  const pending = new Set<string>()
  const reserve = async (name: string) => {
    const upload = await (
      await api(uploads, {
        name,
        size: maxFile,
        idempotencyKey: crypto.randomUUID(),
      })
    ).json()
    assert.ok(
      upload &&
        typeof upload === 'object' &&
        'id' in upload &&
        typeof upload.id === 'string',
    )
    pending.add(upload.id)
    assert.ok('transport' in upload)
    assert.equal(upload.transport, 'multipart')
    return upload.id
  }
  const cancel = async (id: string) => {
    const response = await api(uploads + '/' + id, undefined, 'DELETE')
    assert.equal(response.status, 204)
    pending.delete(id)
  }
  try {
    assert.deepEqual(await capturedAlerts(spool), [])
    await api(uploads, { name: 'oversize', size: maxFile + 1 }, 'POST', 413)
    for (let i = 1; i <= 35; i++) await reserve('quota-' + i)
    assert.deepEqual(await capturedAlerts(spool), [])
    for (let i = 36; i <= 40; i++) await reserve('quota-' + i)
    assert.equal(pending.size, 40)
    await api(uploads, { name: 'overflow', size: 1 }, 'POST', 507)
    const first = pending.values().next().value
    assert.ok(first)
    await cancel(first)
    await reserve('readmitted-at-cap')
    await api(uploads, { name: 'overflow-again', size: 1 }, 'POST', 507)
    let alerts = await capturedAlerts(spool)
    for (let i = 0; !alerts.length && i < 50; i++) {
      await delay(200)
      alerts = await capturedAlerts(spool)
    }
    assert.equal(
      alerts.length,
      1,
      'A single threshold crossing must produce one operator email',
    )
    assert.match(alerts[0]!, /3,600,000,000 bytes/)
    assert.match(alerts[0]!, /4,000,000,000-byte limit/)
  } finally {
    // Every reservation owns an actual S3 multipart upload, even with no parts.
    const cleanup = await Promise.allSettled([...pending].map(cancel))
    const failure = cleanup.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  const page = await (await api('/api/transfers/files')).json()
  assert.ok(page && typeof page === 'object' && 'files' in page)
  assert.deepEqual(page.files, [])
  console.log(
    'Verified the 100 MB file limit, 4 GB in live multipart reservations, a 507 at one byte over capacity, readmission after cancellation, and one native 3.6 GB alert. No object content was uploaded for this check.',
  )
}
