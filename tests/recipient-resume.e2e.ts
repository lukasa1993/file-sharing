import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, test } from '@e2e-dev/web'
import { expect } from 'e2e'
import { shareItem } from './helpers/share.ts'
import { filePayload, uploadFiles } from './helpers/transfer.ts'

describe('resuming a public handoff', { session: 'owner' }, () => {
  test('a signed-out recipient resumes an interrupted transfer at its last received byte', async ({
    app,
    browser,
    screen,
  }) => {
    const file = filePayload('recording.bin', randomBytes(1024 * 1024 + 173))
    const expected = createHash('sha256').update(file.buffer).digest('hex')
    await app.open('/_/files?mount=e2e')
    await uploadFiles(screen, [file])
    await shareItem(screen, file.name)
    await screen
      .getByLabel('Access', { exact: true })
      .selectOption({ value: 'public' })
    await screen.getByRole('checkbox', /I confirm/).check()
    await screen.getByLabel('Open link as').selectOption({ value: 'landing' })
    // Leave enough time to interrupt a real loopback response on either engine.
    await screen.getByText('Expiry and limits', { exact: true }).tap()
    await screen.getByLabel('Download bandwidth (KiB/s)').fill('256')
    await screen.getByRole('button', 'Create link', { exact: true }).tap()
    const url = await screen
      .getByRole('dialog', 'Your link is ready')
      .getByLabel('Share URL')
      .inputValue()
    await browser.clearCookies()
    await app.open(new URL(url).pathname)
    const download = screen.getByRole('link', 'Download', { exact: true })
    const href = await download.getAttribute('href')
    if (!href) throw new Error('The recipient page did not offer its download.')

    const result = await browser.evaluate(async (url: string) => {
      const whole = await fetch(url, { cache: 'no-store' })
      const tag = whole.headers.get('etag')
      if (!whole.body || !tag)
        throw new Error('Missing download stream or validator.')
      const reader = whole.body.getReader()
      const { value: prefix } = await reader.read()
      if (!prefix?.length)
        throw new Error('The download completed without any bytes.')
      await reader.cancel()
      const rest = await fetch(url, {
        cache: 'no-store',
        headers: { Range: 'bytes=' + prefix.length + '-', 'If-Range': tag },
      })
      const suffix = new Uint8Array(await rest.arrayBuffer())
      const bytes = new Uint8Array(prefix.length + suffix.length)
      bytes.set(prefix)
      bytes.set(suffix, prefix.length)
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', bytes),
      )
      return {
        initialStatus: whole.status,
        offset: prefix.length,
        tag,
        resumedStatus: rest.status,
        resumedTag: rest.headers.get('etag'),
        range: rest.headers.get('content-range'),
        length: bytes.length,
        digest: Array.from(digest, (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join(''),
      }
    }, href)
    const saved = await browser.waitForDownload(() => download.tap())
    const savedDigest = createHash('sha256')
      .update(await readFile(saved.absolutePath))
      .digest('hex')

    expect(result.initialStatus).toBe(200)
    expect(result.offset).toBeGreaterThan(0)
    expect(result.offset).toBeLessThan(file.buffer.length)
    expect(result.tag).toMatch(/^"[^"]+"$/)
    expect(result.resumedStatus).toBe(206)
    expect(result.resumedTag).toBe(result.tag)
    expect(result.range).toBe(
      'bytes ' +
        result.offset +
        '-' +
        (file.buffer.length - 1) +
        '/' +
        file.buffer.length,
    )
    expect(result.length).toBe(file.buffer.length)
    expect(result.digest).toBe(expected)
    expect(saved.suggestedFilename).toBe(file.name)
    expect(savedDigest).toBe(expected)
  })
})
