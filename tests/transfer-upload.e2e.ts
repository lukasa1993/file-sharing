import { randomUUID } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, test } from '@e2e-dev/web'
import { expect } from 'e2e'
import { ContentDisposition } from 'remix/headers'
import { downloadFile, filePayload, uploadFiles } from './helpers/transfer'

describe('browser transfers', { session: 'owner' }, () => {
  beforeEach(async ({ app }) => {
    await app.open('/_/files?mount=e2e')
  })

  test('saves the original Unicode filename and binary bytes in a native download', async ({
    screen,
    browser,
  }) => {
    const original = filePayload(
      'résumé % #.bin',
      Buffer.from([0, 255, 127, 32, 1, 13, 10, 128]),
    )
    await uploadFiles(screen, [original])

    const disposition = await browser.evaluate(async (name) => {
      const response = await fetch(
        '/_/download?' + new URLSearchParams({ mount: 'e2e', path: name }),
        { method: 'HEAD' },
      )
      return response.headers.get('content-disposition')
    }, original.name)
    const saved = await downloadFile(screen, browser, original.name)

    expect(ContentDisposition.from(disposition).preferredFilename).toBe(
      original.name,
    )
    // Firefox replaces literal '%' with '_' in its local download filename.
    // Gecko nsExternalHelperAppService::SanitizeFileName applies this after decoding the header.
    const nativeName =
      process.env.E2E_BROWSER === 'firefox'
        ? original.name.replaceAll('%', '_')
        : original.name
    expect(saved.name).toBe(nativeName)
    expect(saved.bytes.equals(original.buffer)).toBe(true)
  })

  test('skipping a conflicting upload keeps the existing file and labels the transfer skipped', async ({
    screen,
    browser,
  }) => {
    const name = 'handoff.txt'
    const original = await readFile(
      new URL('./fixtures/handoff.txt', import.meta.url),
    )
    await screen.getByRole('button', 'Display preferences').tap()
    await screen
      .getByLabel('When uploads have the same name')
      .selectOption({ value: 'skip' })
    await screen.getByRole('button', 'Close Display preferences').tap()

    await screen.getByRole('button', 'Upload files').setInputFiles({
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from('Proposed replacement'),
    })
    const status = screen.getByText(/^Skipped ·/)
    await status.waitFor()
    const message = await status.textContent()
    await screen.getByRole('button', 'Close Transfers').tap()
    const saved = await downloadFile(screen, browser, name)

    expect(message).toContain('Skipped')
    expect(saved.bytes.equals(original)).toBe(true)
  })

  test('the folder picker preserves nested names and file contents', async ({
    screen,
    browser,
  }) => {
    const temp = await mkdtemp(join(tmpdir(), 'e2e-folder-'))
    const name = randomUUID() + ' folder'
    const folder = join(temp, name)
    const text = 'Nested file from a native directory picker.\n'
    try {
      await mkdir(join(folder, '資料'), { recursive: true })
      await writeFile(join(folder, '資料', 'notes.txt'), text)
      await screen.getByRole('button', 'Upload folder').setInputFiles(folder)
      await screen.getByRole('button', 'Dismiss').waitFor()
      await screen.getByRole('button', 'Close Transfers').tap()

      await screen.getByRole('link', name, { exact: true }).tap()
      await screen.getByRole('link', '資料', { exact: true }).tap()
      const saved = await downloadFile(screen, browser, 'notes.txt')

      expect(saved.bytes.toString('utf8')).toBe(text)
      expect(saved.name).toBe('notes.txt')
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })
  test('dropping a file queues its bytes in the currently open folder', async ({
    screen,
    browser,
  }) => {
    const name = randomUUID() + ' dropped.txt',
      text = 'Dropped from the desktop.'
    await browser.evaluate(
      ({ name, text }) => {
        const destination = document.querySelector('[data-upload-url]')
        if (!destination) throw new Error('Missing upload destination.')
        const dataTransfer = new DataTransfer()
        dataTransfer.items.add(new File([text], name, { type: 'text/plain' }))
        destination.dispatchEvent(
          new DragEvent('dragover', {
            dataTransfer,
            bubbles: true,
            cancelable: true,
          }),
        )
        destination.dispatchEvent(
          new DragEvent('drop', {
            dataTransfer,
            bubbles: true,
            cancelable: true,
          }),
        )
        return true
      },
      { name, text },
    )
    await screen.getByRole('button', 'Dismiss').waitFor()
    await screen.getByRole('button', 'Close Transfers').tap()
    const saved = await downloadFile(screen, browser, name)

    expect(saved.bytes.toString('utf8')).toBe(text)
  })
  test('retries a failed chunk without prompting for a file still open in the same tab', async ({
    screen,
    browser,
  }) => {
    const original = filePayload('retry.bin', 'A retried upload.')
    const patch = { method: 'PATCH', url: '**/_/uploads/*' }
    await browser.route(patch, (route) => route.abort())
    await screen.getByRole('button', 'Upload files').setInputFiles(original)
    await screen.getByText(/^Failed ·/).waitFor()
    await browser.unroute(patch)

    await screen.getByRole('button', 'Retry / resume').tap()
    await screen.getByRole('button', 'Dismiss').waitFor()
    await screen.getByRole('button', 'Close Transfers').tap()
    const saved = await downloadFile(screen, browser, original.name)

    expect(saved.bytes.equals(original.buffer)).toBe(true)
  })

  test(
    'recovers a refreshed interrupted upload after verifying the reselected file',
    { timeout: 120000 },
    async ({ screen, browser }) => {
      const temp = await mkdtemp(join(tmpdir(), 'e2e-reselection-'))
      const name = randomUUID() + ' resume.bin'
      const original = join(temp, name)
      const different = join(temp, 'different', name)
      const data = Buffer.alloc(8 * 1024 ** 2 + 133, 0x5c)
      const changed = Buffer.from(data)
      changed[0] = 0
      const touched = new Date('2025-05-01T00:00:00Z')
      try {
        await mkdir(join(temp, 'different'))
        await writeFile(original, data)
        await writeFile(different, changed)
        await utimes(original, touched, touched)
        await utimes(different, touched, touched)
        let interruptedOffset: number | undefined
        const patch = { method: 'PATCH', url: '**/_/uploads/*' }
        await browser.route(patch, async (route) => {
          const at = Number(route.request.headers['upload-offset'])
          if (at > 0 && interruptedOffset === undefined) {
            interruptedOffset = at
            await route.abort()
          } else await route.continue()
        })
        await screen.getByRole('button', 'Upload files').setInputFiles(original)
        await screen.getByText(/^Failed ·/).waitFor()
        await browser.unroute(patch)
        await browser.reload()
        await screen.getByRole('button', /^Transfers/).tap()
        const choose = screen.getByRole('button', 'Choose file to resume')
        await choose.setInputFiles(different)
        const mismatch = screen.getByText(
          'This file differs from the original.',
          { exact: false },
        )
        await mismatch.waitFor()
        const reason = await mismatch.textContent()

        await choose.setInputFiles(original)
        await screen.getByRole('button', 'Dismiss').waitFor()
        await screen.getByRole('button', 'Close Transfers').tap()
        const saved = await downloadFile(screen, browser, name)

        expect(interruptedOffset).toBeGreaterThan(0)
        expect(reason).toContain('differs from the original')
        expect(saved.bytes.equals(data)).toBe(true)
      } finally {
        await rm(temp, { recursive: true, force: true })
      }
    },
  )

  test('cancelling after the final acknowledgement was lost recovers the completed file', async ({
    screen,
    browser,
  }) => {
    const original = filePayload(
      'final-ack.txt',
      'Published before disconnect.',
    )
    let acknowledged = 0
    await browser.route(
      { method: 'PATCH', url: '**/_/uploads/*' },
      async (route) => {
        const upstream = await route.fetch()
        acknowledged = upstream.status
        await route.abort()
      },
    )
    await screen.getByRole('button', 'Upload files').setInputFiles(original)
    await screen.getByText(/^Failed ·/).waitFor()

    await screen.getByRole('button', 'Cancel', { exact: true }).tap()
    await screen.getByText(/^Completed ·/).waitFor()
    await screen.getByRole('button', 'Close Transfers').tap()
    const saved = await downloadFile(screen, browser, original.name)

    expect(acknowledged).toBe(204)
    expect(saved.bytes.equals(original.buffer)).toBe(true)
  })

  test('replacing a duplicate requires confirmation and changes the intended file', async ({
    screen,
    browser,
  }) => {
    const original = filePayload('duplicate.txt', 'First version.')
    await uploadFiles(screen, [original])
    await screen.getByRole('button', 'Display preferences').tap()
    const select = screen.getByLabel('When uploads have the same name')
    const dismiss = await browser.onDialog('dismiss')
    await select.selectOption({ value: 'overwrite' })
    expect(await select.inputValue()).toBe('reject')
    await dismiss()
    const accept = await browser.onDialog('accept')
    await select.selectOption({ value: 'overwrite' })
    await accept()
    await screen.getByRole('button', 'Close Display preferences').tap()
    const replacement = {
      ...original,
      buffer: Buffer.from('Approved revision.'),
    }
    await screen.getByRole('button', /^Transfers/).tap()
    await screen.getByRole('button', 'Dismiss').tap()
    await screen.getByRole('button', 'Close Transfers').tap()
    await uploadFiles(screen, [replacement])
    const saved = await downloadFile(screen, browser, original.name)

    expect(saved.bytes.equals(replacement.buffer)).toBe(true)
  })

  test('cancelling during session creation also releases the server reservation', async ({
    screen,
    browser,
  }) => {
    const pending = Promise.withResolvers<void>(),
      allow = Promise.withResolvers<void>()
    const original = filePayload(
      'cancel-create.bin',
      'Must never be published.',
    )
    await browser.route(
      { method: 'POST', url: '**/_/uploads' },
      async (route) => {
        pending.resolve()
        await allow.promise
        await route.continue()
      },
    )
    try {
      await screen.getByRole('button', 'Upload files').setInputFiles(original)
      await pending.promise
      await screen.getByRole('button', 'Cancel', { exact: true }).tap()
      await screen.getByText(/^Cancelling ·/).waitFor()
      const removed = browser.waitForResponse({
        method: 'DELETE',
        url: '**/_/uploads/*',
      })
      allow.resolve()
      const response = await removed
      await screen.getByText(/^Cancelled ·/).waitFor()
      const after = await browser.evaluate(
        async (url) =>
          (
            await fetch(url, {
              method: 'HEAD',
              headers: { 'Tus-Resumable': '1.0.0' },
            })
          ).status,
        response.url,
      )

      expect(response.status).toBe(204)
      expect(after).toBe(404)
      await expect(screen.getByRole('link', original.name)).toHaveCount(0)
    } finally {
      allow.resolve()
    }
  })

  test(
    'cancelling a paused upload dismisses the queue entry and leaves the destination empty',
    { timeout: 60000 },
    async ({ screen, browser }) => {
      const original = filePayload('cancel.bin', 'Interrupted transfer')
      const intercepted = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const patch = { method: 'PATCH', url: '**/_/uploads/*' }
      await browser.route(patch, async (route) => {
        intercepted.resolve()
        await release.promise
        await route.abort()
      })
      try {
        await screen.getByRole('button', 'Upload files').setInputFiles(original)
        await intercepted.promise
        await screen.getByRole('button', 'Pause').tap()
        await screen.getByText(/^Paused ·/).waitFor()
        release.resolve()

        await screen.getByRole('button', 'Cancel', { exact: true }).tap()
        await screen.getByText(/^Cancelled ·/).waitFor()
        await screen.getByRole('button', 'Dismiss').tap()
        const status = await screen
          .getByText('No transfers in this session.')
          .textContent()
        await screen.getByRole('button', 'Close Transfers').tap()
        await screen.getByRole('button', 'Refresh files').tap()

        expect(status).toBe('No transfers in this session.')
        await expect(screen.getByRole('link', original.name)).toHaveCount(0)
      } finally {
        release.resolve()
      }
    },
  )
})
