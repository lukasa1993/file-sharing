import { readFile } from 'node:fs/promises'
import { beforeEach, describe, test } from '@e2e-dev/web'
import { expect } from 'e2e'
import { parseTar } from 'remix/tar-parser'
import { filePayload, uploadFiles } from './helpers/transfer'

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
  test('an unavailable file preview still offers its original bytes for download', async ({
    screen,
    browser,
  }) => {
    const original = filePayload(
      'project.bin',
      Buffer.from([0, 1, 255, 128, 0]),
    )
    await uploadFiles(screen, [original])

    await screen.getByRole('link', original.name).tap()
    const message = screen.getByText(
      'A preview is unavailable for this format.',
    )
    await message.waitFor()
    const saved = await browser.waitForDownload(() =>
      screen.getByRole('link', 'Download', { exact: true }).tap(),
    )
    const bytes = await readFile(saved.absolutePath)

    await expect(message).toBeVisible()
    expect(bytes.equals(original.buffer)).toBe(true)
  })

  test('an uploaded TAR shows its member listing as a read-only preview', async ({
    screen,
    browser,
  }) => {
    const note = filePayload('leaf.txt', 'contents')
    await uploadFiles(screen, [note])
    await screen.getByRole('checkbox', 'Select ' + note.name).check()
    const tar = await browser.waitForDownload(() =>
      screen.getByRole('button', 'Download archive', { exact: true }).tap(),
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

  test('a selection downloads a TAR containing exactly its original names and bytes', async ({
    screen,
    browser,
  }) => {
    const files = [
      filePayload('第一 réf.txt', 'Uncompressed text\n'),
      filePayload('selected.bin', Buffer.from([255, 0, 123])),
    ]
    await uploadFiles(screen, files)
    for (const file of files)
      await screen.getByRole('checkbox', 'Select ' + file.name).check()

    const saved = await browser.waitForDownload(() =>
      screen.getByRole('button', 'Download archive', { exact: true }).tap(),
    )
    const bytes = await readFile(saved.absolutePath)
    const entries: Record<string, string> = {}
    await parseTar(
      new Blob([new Uint8Array(bytes)]).stream(),
      async (entry) => {
        entries[entry.name] = Buffer.from(await entry.arrayBuffer()).toString(
          'hex',
        )
      },
    )

    expect(saved.suggestedFilename).toBe('shared-files.tar')
    expect(entries).toEqual(
      Object.fromEntries(
        files.map((file) => [file.name, file.buffer.toString('hex')]),
      ),
    )
  })
})
