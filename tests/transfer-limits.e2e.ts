import { readFile } from 'node:fs/promises'
import { filePayload, uploadFiles } from './helpers/transfer.ts'
import { describe, test } from '@e2e-dev/web'
import { expect } from 'e2e'

describe('transfer administration', { session: 'owner' }, () => {
  test('saves and reopens the effective preview and staging policy', async ({
    app,
    screen,
    browser,
  }) => {
    const name = 'Preview and staging limits'
    const panel = screen.getByRole('form', name, { exact: true })
    const open = async () => {
      await app.open('/_/admin')
      await screen.getByText(name, { exact: true, visible: true }).tap()
    }
    await open()
    const text = panel.getByLabel('Text preview and edit limit (KiB)')
    const original = await text.inputValue()
    const saved = original === '255' ? '254' : '255'
    try {
      await text.fill(saved)
      await panel.getByRole('button', 'Save limits').tap()
      await panel.waitFor({ state: 'hidden' })
      await open()
      await expect(text).toHaveValue(saved)
      await expect(
        panel.getByLabel('Maximum size per upload (bytes)'),
      ).toBeVisible()
      await expect(
        panel.getByLabel('Staging capacity per storage root (bytes)'),
      ).toBeVisible()
      await app.open('/_/files?mount=e2e')
      const originalFile = filePayload(
        'bounded-preview.txt',
        'Preview text\n' + ' '.repeat(Number(saved) * 1024) + 'end of original',
        'text/plain',
      )
      await uploadFiles(screen, [originalFile])
      await screen.getByRole('link', originalFile.name, { exact: true }).tap()
      await expect(
        screen.getByText(
          'Showing the beginning of this file. Download the original to read the rest.',
        ),
      ).toBeVisible()
      await expect(screen.getByRole('button', 'Edit text')).toHaveCount(0)
      const downloaded = await browser.waitForDownload(() =>
        screen.getByRole('link', 'Download', { exact: true }).tap(),
      )
      expect(
        (await readFile(downloaded.absolutePath)).equals(originalFile.buffer),
      ).toBe(true)
    } finally {
      await open()
      await text.fill(original)
      await panel.getByRole('button', 'Save limits').tap()
      await panel.waitFor({ state: 'hidden' })
    }
  })
})
