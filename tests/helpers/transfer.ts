import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Browser } from '@e2e-dev/web'
import type { TestFixtures } from 'e2e'

type Screen = TestFixtures['screen']
export function filePayload(
  label: string,
  bytes: string | Buffer,
  type = 'application/octet-stream',
) {
  return {
    name: randomUUID() + ' ' + label,
    mimeType: type,
    buffer: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
  }
}
export async function uploadFiles(
  screen: Screen,
  files: ReturnType<typeof filePayload>[],
) {
  await screen.getByRole('button', 'Upload files').setInputFiles(files)
  for (const file of files)
    await screen
      .getByRole('group', file.name, { exact: true })
      .getByRole('button', 'Dismiss')
      .waitFor()
  await screen.getByRole('button', 'Close Transfers').tap()
  for (const file of files)
    await screen.getByRole('link', file.name, { exact: true }).waitFor()
}
export async function downloadFile(
  screen: Screen,
  browser: Browser,
  name: string,
) {
  await screen.getByRole('button', 'Actions for ' + name).tap()
  const saved = await browser.waitForDownload(() =>
    screen.getByRole('button', 'Download', { exact: true }).tap(),
  )
  return {
    name: saved.suggestedFilename,
    bytes: await readFile(saved.absolutePath),
  }
}
