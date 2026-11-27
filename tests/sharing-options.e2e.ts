import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { beforeEach, describe, test } from '@e2e-dev/web'
import { expect, type TestFixtures } from 'e2e'
import { folder, shareItem } from './helpers/share.ts'
import { filePayload, uploadFiles } from './helpers/transfer.ts'

type Screen = TestFixtures['screen']
const unique = (prefix: string) => prefix + '-' + randomUUID().slice(0, 12)

async function publicAccess(screen: Screen) {
  await screen
    .getByLabel('Access', { exact: true })
    .selectOption({ value: 'public' })
  await screen.getByRole('checkbox', /I confirm/).check()
}
async function options(screen: Screen) {
  await screen.getByText('Expiry and limits', { exact: true }).tap()
  await screen.getByLabel('Expires at').waitFor()
}
async function save(screen: Screen, button: string) {
  await screen.getByRole('button', button, { exact: true }).tap()
  const result = screen.getByRole('dialog', 'Your link is ready')
  await result.waitFor()
  const url = await result.getByLabel('Share URL').inputValue()
  await screen.getByRole('button', 'Done', { exact: true }).tap()
  return new URL(url).pathname
}
async function edit(app: TestFixtures['app'], screen: Screen, path: string) {
  await app.open('/_/shares')
  await screen
    .getByRole('article')
    .filter({
      has: screen.getByRole('checkbox', 'Select ' + path, { exact: true }),
    })
    .getByRole('button', 'Edit')
    .tap()
  await options(screen)
}

describe('owner share options', { session: 'owner' }, () => {
  beforeEach(async ({ app }) => {
    await app.open('/_/files?mount=e2e')
  })

  test('a random direct link honors a resumed download lease and the owner’s expiry', async ({
    app,
    browser,
    screen,
    request,
  }) => {
    const original = await readFile(
      new URL('./fixtures/handoff.txt', import.meta.url),
      'utf8',
    )
    const future = new Date(Date.now() + 7 * 86400000)
      .toISOString()
      .slice(0, 16)
    await shareItem(screen, 'handoff.txt')
    await publicAccess(screen)
    await options(screen)
    await screen.getByLabel('Expires at').fill(future)
    await screen.getByLabel('Download limit', { exact: true }).fill('1')
    const path = await save(screen, 'Create link')
    await edit(app, screen, path)
    const expiry = await screen.getByLabel('Expires at').inputValue()
    const limit = await screen
      .getByLabel('Download limit', { exact: true })
      .inputValue()
    const mode = await screen.getByLabel('Open link as').inputValue()
    // A browser download manager retries and resumes with the same session and representation.
    const first = await browser.evaluate(async (path: string) => {
      const head = await fetch(path, { method: 'HEAD' })
      const whole = await fetch(path)
      const etag = whole.headers.get('etag') || ''
      const original = await whole.text()
      const part = await fetch(path, {
        headers: { Range: 'bytes=0-3', 'If-Range': etag },
      })
      return {
        head: head.status,
        status: whole.status,
        disposition: whole.headers.get('content-disposition'),
        original,
        partStatus: part.status,
        prefix: await part.text(),
      }
    }, path)
    const spent = await request.get(path)
    await screen.getByLabel('Expires at').fill('2020-06-15T12:00')
    await publicAccess(screen)
    await save(screen, 'Save changes')
    const expired = await request.get(path)

    expect(path).toMatch(/^\/[0-9a-f]{32}$/)
    expect(expiry).toBe(future)
    expect(limit).toBe('1')
    expect(mode).toBe('direct')
    expect(first).toMatchObject({
      head: 200,
      status: 200,
      original,
      partStatus: 206,
      prefix: original.slice(0, 4),
    })
    expect(first.disposition).toContain('attachment')
    expect(spent.status).toBe(410)
    expect(expired.status).toBe(404)
    await expect(
      screen.getByRole('article').filter({ hasText: path }),
    ).toContainText('Expired')
  })

  test('a latest-at-path landing link serves revised bytes and keeps its configured download rate', async ({
    app,
    browser,
    screen,
  }) => {
    const file = filePayload(
      'releases.txt',
      'Original release notes\n',
      'text/plain',
    )
    const revised = 'Revised payload.\n'
    await uploadFiles(screen, [file])
    await shareItem(screen, file.name)
    const alias = unique('release')
    await screen.getByRole('textbox', /^Link address/).fill(alias)
    await publicAccess(screen)
    await screen.getByLabel('Open link as').selectOption({ value: 'landing' })
    await options(screen)
    await screen.getByLabel('Download bandwidth (KiB/s)').fill('1.5')
    await screen.getByRole('checkbox', /Share the latest version/).check()
    const path = await save(screen, 'Create link')
    await edit(app, screen, path)
    const configuredRate = await screen
      .getByLabel('Download bandwidth (KiB/s)')
      .inputValue()
    const follows = await screen
      .getByRole('checkbox', /Share the latest version/)
      .isChecked()
    const mode = await screen.getByLabel('Open link as').inputValue()
    await app.open('/_/files?mount=e2e')
    await screen.getByRole('link', file.name, { exact: true }).tap()
    await screen.getByRole('button', 'Edit text').tap()
    await screen.getByLabel('File contents').fill(revised)
    await screen.getByRole('button', 'Save changes', { exact: true }).tap()
    await screen.getByText('Changes saved.', { exact: true }).waitFor()
    await browser.clearCookies()
    await app.open(path)
    const received = await browser.waitForDownload(() =>
      screen.getByRole('link', 'Download', { exact: true }).tap(),
    )

    await expect(
      screen.getByRole('heading', file.name, { exact: true }),
    ).toBeVisible()
    expect(configuredRate).toBe('1.5')
    expect(follows).toBe(true)
    expect(mode).toBe('landing')
    expect(received.suggestedFilename).toBe(file.name)
    expect(await readFile(received.absolutePath, 'utf8')).toBe(revised)
  })

  test('a fractional MiB request cap is shared across completed uploads from separate guest sessions', async ({
    app,
    screen,
    browser,
  }) => {
    const name = unique('drop')
    await folder(screen, name)
    await shareItem(screen, name, true)
    await publicAccess(screen)
    await options(screen)
    const kibInMib = String(1 / 1024)
    await screen.getByLabel('Total upload limit (MiB)').fill(kibInMib)
    const path = await save(screen, 'Create upload link')
    await edit(app, screen, path)
    const limit = await screen
      .getByLabel('Total upload limit (MiB)')
      .inputValue()
    const rateControl = await screen
      .getByLabel('Download bandwidth (KiB/s)')
      .isVisible()
    await browser.clearCookies()
    await app.open(path)
    await screen.getByRole('button', 'Choose files').setInputFiles({
      name: 'first.txt',
      mimeType: 'text/plain',
      buffer: Buffer.alloc(800, 65),
    })
    await screen.getByText(/Completed ·/).waitFor()
    await browser.clearCookies()
    await app.open(path)
    await screen.getByRole('button', 'Choose files').setInputFiles({
      name: 'second.txt',
      mimeType: 'text/plain',
      buffer: Buffer.alloc(225, 66),
    })

    await expect(screen.getByRole('alert')).toContainText(
      'Upload capacity exceeded',
    )
    expect(rateControl).toBe(false)
    expect(limit).toBe(kibInMib)
  })
})
