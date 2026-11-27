import { readFile } from 'node:fs/promises'
import { beforeEach, describe, test } from '@e2e-dev/web'
import { expect } from 'e2e'
import { folder } from './helpers/share'
import { archiveMembers, filePayload, uploadFiles } from './helpers/transfer'

describe('file previews and archives', { session: 'owner' }, () => {
  beforeEach(async ({ app }) => {
    await app.open('/_/files?mount=e2e')
  })

  test('editing a text preview persists the saved Unicode text in the original download', async ({
    screen,
    browser,
  }) => {
    const original = filePayload('notes.txt', 'Draft notes.', 'text/plain')
    const revision = 'Updated résumé.\nこんにちは\n'
    await uploadFiles(screen, [original])
    await screen.getByRole('link', original.name).tap()
    await screen.getByText('Draft notes.', { exact: true }).waitFor()
    await screen.getByRole('button', 'Edit text').tap()

    await screen.getByLabel('File contents').fill(revision)
    await screen.getByRole('button', 'Save changes').tap()
    await screen.getByText('Changes saved.').waitFor()
    await screen.getByRole('link', original.name).tap()
    const displayed = screen.getByText('Updated résumé.', { exact: false })
    await displayed.waitFor()
    const saved = await browser.waitForDownload(() =>
      screen.getByRole('link', 'Download', { exact: true }).tap(),
    )
    const bytes = await readFile(saved.absolutePath)

    await expect(displayed).toContainText('こんにちは')
    expect(bytes.toString('utf8')).toBe(revision)
    expect(saved.suggestedFilename).toBe(original.name)
  })

  test('decodes an uploaded raster image inside the preview dialog', async ({
    screen,
    browser,
  }) => {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ2YAAAAASUVORK5CYII=',
      'base64',
    )
    const image = filePayload('pixel.png', bytes, 'image/png')
    await uploadFiles(screen, [image])

    await screen.getByRole('link', image.name).tap()
    const preview = screen.getByRole('img', image.name)
    await preview.waitFor()

    await expect(preview).toBeVisible()
    await expect
      .poll(() =>
        browser.evaluate(
          () =>
            document.querySelector<HTMLImageElement>('dialog[open] img')
              ?.naturalWidth ?? 0,
        ),
      )
      .toBe(1)
  })

  test('opens a playable audio preview with native media controls', async ({
    screen,
    browser,
  }) => {
    const samples = 800
    const wav = Buffer.alloc(44 + samples, 128)
    wav.write('RIFF', 0)
    wav.writeUInt32LE(36 + samples, 4)
    wav.write('WAVEfmt ', 8)
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(8000, 24)
    wav.writeUInt32LE(8000, 28)
    wav.writeUInt16LE(1, 32)
    wav.writeUInt16LE(8, 34)
    wav.write('data', 36)
    wav.writeUInt32LE(samples, 40)
    const track = filePayload('sample.wav', wav, 'audio/wav')
    await uploadFiles(screen, [track])

    await screen.getByRole('link', track.name).tap()
    await browser.locator('dialog[open] audio[controls]').waitFor()

    await expect
      .poll(() =>
        browser.evaluate(() => {
          const media =
            document.querySelector<HTMLAudioElement>('dialog[open] audio')
          return media?.controls === true && media.duration > 0
        }),
      )
      .toBe(true)
  })
  test('plays a native WebM preview and preserves a download when the browser cannot decode a video', async ({
    screen,
    browser,
  }) => {
    const playable = filePayload(
      'colours.webm',
      await readFile(new URL('./fixtures/color-frames.webm', import.meta.url)),
      'video/webm',
    )
    const incomplete = filePayload(
      'incomplete.mp4',
      Buffer.from('0000ftypisom'),
      'video/mp4',
    )
    await uploadFiles(screen, [playable, incomplete])
    await screen.getByRole('link', playable.name).tap()
    await expect
      .poll(() =>
        browser.evaluate(() => {
          const video =
            document.querySelector<HTMLVideoElement>('dialog[open] video')
          return video?.controls && video.readyState >= 2
            ? [video.videoWidth, video.videoHeight]
            : []
        }),
      )
      .toEqual([32, 24])
    await screen.getByRole('button', 'Close Preview').tap()

    await screen.getByRole('link', incomplete.name).tap()
    await screen
      .getByText(
        'This browser could not display the file. Download it to open it.',
      )
      .waitFor()
    const saved = await browser.waitForDownload(() =>
      screen.getByRole('link', 'Download', { exact: true }).tap(),
    )
    expect((await readFile(saved.absolutePath)).equals(incomplete.buffer)).toBe(
      true,
    )
  })

  test('opens a formatted Markdown document with an inert external reference', async ({
    screen,
    browser,
  }) => {
    const doc = filePayload(
      'guide.markdown',
      '# Project notes\n\nSee the [manual](https://example.invalid/guide).\n',
      'text/markdown',
    )
    await uploadFiles(screen, [doc])
    await screen.getByRole('link', doc.name).tap()
    await screen.getByText('# Project notes', { exact: false }).waitFor()
    const opened = await browser.waitForPopup(() =>
      screen.getByRole('link', 'Open formatted preview').tap(),
    )
    await expect(screen.getByRole('heading', 'Project notes')).toBeVisible()
    await expect(
      screen.getByText('See the manual.', { exact: true }),
    ).toBeVisible()
    await expect(screen.getByRole('link', 'manual')).toHaveCount(0)
    await opened.close()
  })

  test('an unavailable file preview still offers its original bytes for download', async ({
    screen,
    browser,
  }) => {
    const originals = [
      filePayload('project.bin', Buffer.from([0, 1, 255, 128, 0])),
      filePayload(
        'document.pdf',
        await readFile(new URL('./fixtures/blank-page.pdf', import.meta.url)),
        'application/pdf',
      ),
      filePayload(
        'office.rtf',
        '{\\rtf1\\ansi Office notes.}',
        'application/rtf',
      ),
      filePayload(
        'photo.avif',
        await readFile(
          new URL('./fixtures/white-square.avif', import.meta.url),
        ),
        'image/avif',
      ),
    ]
    await uploadFiles(screen, originals)
    for (const [index, original] of originals.entries()) {
      if (index > 0) await screen.getByRole('button', 'Close Preview').tap()
      await screen.getByRole('link', original.name, { exact: true }).tap()
      await expect(
        screen.getByText('A preview is unavailable for this file.'),
      ).toBeVisible()
      const download = screen.getByRole('link', 'Download', { exact: true })
      // Firefox saves AVIF attachments to its temporary directory and opens its native image viewer.
      // Its browser download event does not fire for this configured file action.
      if (
        process.env.E2E_BROWSER === 'firefox' &&
        original.name.endsWith('.avif')
      ) {
        const url = await download.getAttribute('href')
        if (!url) throw new Error('Missing original-file download URL.')
        const response = await browser.evaluate(async (url) => {
          const original = await fetch(url)
          return {
            disposition: original.headers.get('Content-Disposition'),
            bytes: Array.from(new Uint8Array(await original.arrayBuffer())),
          }
        }, url)
        expect(response.disposition).toContain('attachment')
        expect(Buffer.from(response.bytes).equals(original.buffer)).toBe(true)
        await download.focus()
        const tab = await browser.waitForPopup(() =>
          browser.keyboard.press('Enter'),
        )
        const local = new URL(await browser.url())
        expect(local.protocol).toBe('file:')
        expect(decodeURIComponent(local.pathname.split('/').pop() || '')).toBe(
          original.name,
        )
        await tab.close()
      } else {
        const saved = await browser.waitForDownload(() => download.tap())
        expect(saved.suggestedFilename).toBe(original.name)
        expect(
          (await readFile(saved.absolutePath)).equals(original.buffer),
        ).toBe(true)
      }
    }
  })

  test('an uploaded TAR shows its member listing as a read-only preview', async ({
    screen,
    browser,
  }) => {
    const note = filePayload('leaf.txt', 'contents')
    await uploadFiles(screen, [note])
    await screen.getByRole('checkbox', 'Select ' + note.name).check()
    const tar = await browser.waitForDownload(() =>
      screen.getByRole('button', 'Download TAR', { exact: true }).tap(),
    )
    const input = filePayload(
      'listing.tar',
      await readFile(tar.absolutePath),
      'application/x-tar',
    )
    await uploadFiles(screen, [input])

    await screen.getByRole('link', input.name).tap()
    const listing = screen.getByText(note.name + '  8 bytes', { exact: true })
    await listing.waitFor()

    await expect(listing).toBeVisible()
    await expect(screen.getByRole('button', 'Edit text')).toHaveCount(0)
  })

  test('exports a folder and a selection in both archive formats with their original bytes', async ({
    app,
    screen,
    browser,
  }) => {
    const directory = crypto.randomUUID() + ' export'
    const nested = filePayload('第一 réf.txt', 'Nested text\n')
    const selected = filePayload('selected.bin', Buffer.from([255, 0, 123]))
    await folder(screen, directory)
    await screen.getByRole('link', directory, { exact: true }).tap()
    await uploadFiles(screen, [nested])
    await app.open('/_/files?mount=e2e')
    await uploadFiles(screen, [selected])

    const members = {
      [directory]: '',
      [directory + '/' + nested.name]: nested.buffer.toString('hex'),
    }
    for (const format of ['tar', 'tar.gz'] as const) {
      await screen
        .getByRole('button', 'Actions for ' + directory, { exact: true })
        .tap()
      const saved = await browser.waitForDownload(() =>
        screen
          .getByRole('button', 'Download ' + format.toUpperCase(), {
            exact: true,
          })
          .tap(),
      )
      expect(saved.suggestedFilename).toBe('shared-files.' + format)
      expect(await archiveMembers(saved.absolutePath, format)).toEqual(members)
    }
    for (const name of [directory, selected.name])
      await screen
        .getByRole('checkbox', 'Select ' + name, { exact: true })
        .check()
    for (const format of ['tar', 'tar.gz'] as const) {
      const saved = await browser.waitForDownload(() =>
        screen
          .getByRole('button', 'Download ' + format.toUpperCase(), {
            exact: true,
          })
          .tap(),
      )
      expect(saved.suggestedFilename).toBe('shared-files.' + format)
      expect(await archiveMembers(saved.absolutePath, format)).toEqual({
        ...members,
        [selected.name]: selected.buffer.toString('hex'),
      })
    }
  })
})
