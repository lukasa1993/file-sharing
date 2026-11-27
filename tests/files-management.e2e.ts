import { randomUUID } from 'node:crypto'
import { beforeEach, describe, test, type Browser } from '@e2e-dev/web'
import { expect, type Screen } from 'e2e'
import { downloadFile } from './helpers/transfer.ts'

const unique = (label: string) => label + '-' + randomUUID().slice(0, 8)
const main = (screen: Screen) => screen.getByRole('main')
const entry = (screen: Screen, name: string) =>
  main(screen).getByRole('link', name, { exact: true })
const button = (screen: Screen, name: string) =>
  screen.getByRole('button', name, { exact: true })

async function newFolder(screen: Screen, name: string) {
  await button(screen, 'New folder').tap()
  const dialog = screen.getByRole('dialog', 'New folder')
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('button', 'Create folder').tap()
  await entry(screen, name).waitFor()
}
async function openFolder(screen: Screen, name: string) {
  await entry(screen, name).tap()
  await screen.getByRole('heading', name, { level: 1 }).waitFor()
}
async function actions(screen: Screen, name: string, action: string) {
  await button(screen, 'Actions for ' + name).tap()
  await screen
    .getByRole('dialog', 'File actions')
    .getByRole('button', action)
    .tap()
}
async function upToRoot(screen: Screen) {
  await screen
    .getByRole('navigation', 'Storage')
    .getByRole('link', 'Files')
    .tap()
  await screen.getByRole('heading', 'Files', { level: 1 }).waitFor()
}
async function upload(
  screen: Screen,
  browser: Browser,
  name: string,
  text: string,
) {
  await Promise.all([
    browser.waitForResponse({ method: 'PATCH', url: '**/_/uploads/*' }),
    screen.getByLabel('Choose files to upload').setInputFiles({
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from(text),
    }),
  ])
  const progress = screen.getByRole('dialog', 'Transfers')
  await progress.getByRole('button', 'Close Transfers').tap()
  await button(screen, 'Refresh files').tap()
  await entry(screen, name).waitFor()
}
async function download(screen: Screen, browser: Browser, name: string) {
  const saved = await downloadFile(screen, browser, name)
  return { name: saved.name, text: saved.bytes.toString('utf8') }
}
async function sendTo(
  screen: Screen,
  op: 'Copy' | 'Move',
  name: string,
  folder: string,
) {
  await actions(screen, name, op + ' to')
  const modal = screen.getByRole('dialog', op + ' items')
  await modal.getByLabel('Destination folder').fill(folder)
  await modal.getByRole('button', op).tap()
  await modal.waitFor({ state: 'hidden' })
}

describe('file management', { session: 'owner' }, () => {
  beforeEach(async ({ app }) => {
    await app.open('/_/files?mount=e2e')
  })

  test('opens a nested folder from the expandable storage navigation', async ({
    screen,
    browser,
  }) => {
    const parent = unique('departments'),
      child = unique('reviews')
    await newFolder(screen, parent)
    await openFolder(screen, parent)
    await newFolder(screen, child)
    await upToRoot(screen)
    const storage = screen.getByRole('navigation', 'Storage')

    await storage.getByRole('button', 'Folders in Files').tap()
    await storage.getByRole('button', 'Folders in ' + parent).tap()
    await storage.getByRole('link', child).tap()

    await expect(screen.getByRole('heading', child, { level: 1 })).toBeVisible()
    await expect(
      screen.getByRole('navigation', 'Breadcrumb').getByRole('link', parent),
    ).toBeVisible()
    expect(new URL(await browser.url()).searchParams.get('path')).toBe(
      parent + '/' + child,
    )
  })

  test('saves edited text as the bytes of the uploaded file', async ({
    screen,
    browser,
  }) => {
    const name = unique('notes') + '.txt',
      revision = 'Revised in Chromium — 42%\n'
    await upload(screen, browser, name, 'Initial draft\n')
    await entry(screen, name).tap()
    await button(screen, 'Edit text').tap()
    await screen.getByLabel('File contents').fill(revision)

    await button(screen, 'Save changes').tap()
    await screen.getByText('Changes saved.', { exact: true }).waitFor()
    const received = await download(screen, browser, name)

    expect(received.name).toBe(name)
    expect(received.text).toBe(revision)
  })

  test('renames a file inline without changing its contents', async ({
    screen,
    browser,
  }) => {
    const name = unique('draft') + '.txt',
      target = unique('final') + '.txt'
    await upload(screen, browser, name, 'Reviewed\n')

    await actions(screen, name, 'Rename')
    await screen.getByLabel('New filename').fill(target)
    await button(screen, 'Save').tap()
    await entry(screen, target).waitFor()
    const received = await download(screen, browser, target)

    await expect(entry(screen, target)).toBeVisible()
    await expect(entry(screen, name)).toHaveCount(0)
    expect(received).toEqual({ name: target, text: 'Reviewed\n' })
  })

  test.each([
    { op: 'Copy' as const, sourceCount: 1 },
    { op: 'Move' as const, sourceCount: 0 },
  ])(
    '$op places the file in the requested destination',
    async ({ op, sourceCount }, { screen, browser }) => {
      const name = unique('assignment') + '.txt',
        dest = unique('inbox'),
        text = 'File bytes from the source'
      await newFolder(screen, dest)
      await upload(screen, browser, name, text)

      await sendTo(screen, op, name, dest)
      await openFolder(screen, dest)
      const received = await download(screen, browser, name)
      await upToRoot(screen)

      await expect(entry(screen, name)).toHaveCount(sourceCount)
      expect(received).toEqual({ name, text })
    },
  )

  test('bulk renames a selection through the visible controls', async ({
    screen,
  }) => {
    const first = unique('research'),
      second = unique('planning')
    await newFolder(screen, first)
    await newFolder(screen, second)
    await screen.getByRole('checkbox', 'Select ' + first).check()
    await screen.getByRole('checkbox', 'Select ' + second).check()

    await button(screen, 'Rename items').tap()
    const dialog = screen.getByRole('dialog', 'Rename selected items')
    await dialog.getByLabel('e2e / ' + first).fill(first + '-approved')
    await dialog.getByLabel('e2e / ' + second).fill(second + '-approved')
    await dialog.getByRole('button', 'Rename items').tap()

    await expect(entry(screen, first + '-approved')).toBeVisible()
    await expect(entry(screen, second + '-approved')).toBeVisible()
    await expect(entry(screen, first)).toHaveCount(0)
    await expect(entry(screen, second)).toHaveCount(0)
  })

  test('cuts a selected file and pastes it into the open folder', async ({
    screen,
    browser,
  }) => {
    const folder = unique('incoming'),
      name = unique('clip') + '.txt',
      text = 'Moved with the keyboard'
    await newFolder(screen, folder)
    await upload(screen, browser, name, text)
    await screen.getByRole('checkbox', 'Select ' + name).check()
    await entry(screen, name).press('Control+x')
    await openFolder(screen, folder)

    await browser.keyboard.press('Control+v')
    const dialog = screen.getByRole('dialog', 'Move items')
    await dialog.getByRole('button', 'Move').tap()
    await entry(screen, name).waitFor()
    const received = await download(screen, browser, name)
    await upToRoot(screen)

    await expect(entry(screen, name)).toHaveCount(0)
    expect(received).toEqual({ name, text })
  })

  test('restores a trashed document under an unused name when its old name is occupied', async ({
    screen,
    browser,
  }) => {
    const base = unique('minutes'),
      name = base + '.txt',
      restored = base + ' (2).txt'
    await upload(screen, browser, name, 'Original minutes')
    await actions(screen, name, 'Move to trash')
    await screen
      .getByRole('dialog', 'Move to trash')
      .getByRole('button', 'Move to trash')
      .tap()
    await screen.getByText('Moved to trash.', { exact: true }).waitFor()
    await upload(screen, browser, name, 'Replacement minutes')
    await screen.getByRole('link', 'Trash').tap()

    await screen
      .getByRole('article')
      .filter({ hasText: name })
      .getByRole('button', 'Restore')
      .tap()
    await screen
      .getByRole('dialog', 'Confirm action')
      .getByRole('button', 'Confirm')
      .tap()
    await screen.getByText('Item restored.', { exact: true }).waitFor()
    await upToRoot(screen)
    const previous = await download(screen, browser, restored)
    const replacement = await download(screen, browser, name)

    expect(previous).toEqual({ name: restored, text: 'Original minutes' })
    expect(replacement).toEqual({ name, text: 'Replacement minutes' })
  })

  test('searches inside the selected folder and its subfolders', async ({
    screen,
    browser,
  }) => {
    const parent = unique('reports'),
      child = 'archive',
      name = unique('summary') + '.txt'
    await newFolder(screen, parent)
    await openFolder(screen, parent)
    await newFolder(screen, child)
    await openFolder(screen, child)
    await upload(screen, browser, name, 'Nested report')
    await screen
      .getByRole('navigation', 'Breadcrumb')
      .getByRole('link', parent)
      .tap()
    await screen.getByRole('heading', parent, { level: 1 }).waitFor()

    await screen.getByRole('searchbox', 'Search files').fill(name)
    await screen
      .getByRole('combobox', 'Search scope')
      .selectOption('Subfolders')
    await button(screen, 'Run search').tap()
    await screen.getByRole('heading', 'Search results', { level: 1 }).waitFor()
    const received = await download(screen, browser, name)

    await expect(entry(screen, name)).toHaveCount(1)
    expect(received.text).toBe('Nested report')
    expect(new URL(await browser.url()).searchParams.get('path')).toBe(parent)
  })

  test('returns to a saved file through Favorites after navigating away', async ({
    screen,
    browser,
  }) => {
    const parent = unique('favorites'),
      name = unique('pinned') + '.txt'
    await newFolder(screen, parent)
    await openFolder(screen, parent)
    await upload(screen, browser, name, 'Saved item')
    await actions(screen, name, 'Toggle favorite')
    await screen.getByText('Added to favorites.', { exact: true }).waitFor()
    await upToRoot(screen)

    await button(screen, 'Favorites').tap()
    await screen
      .getByRole('dialog', 'Favorites')
      .getByRole('link', 'e2e / ' + parent + ' / ' + name)
      .tap()

    await expect(
      screen.getByRole('heading', parent, { level: 1 }),
    ).toBeVisible()
    await expect(entry(screen, name)).toBeVisible()
  })
})
