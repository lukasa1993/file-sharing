import { randomUUID } from 'node:crypto'
import { describe, test } from '@e2e-dev/web'
import { expect, secrets, type TestFixtures } from 'e2e'
import { filePayload, uploadFiles } from './helpers/transfer.ts'

const storage = '/_/files?mount=e2e'

async function createFolder(screen: TestFixtures['screen']) {
  const folder = 'Interface ' + randomUUID().slice(0, 8)
  await screen.getByRole('button', 'New folder').tap()
  const dialog = screen.getByRole('dialog', 'New folder')
  await dialog.getByLabel('Name').fill(folder)
  await dialog.getByRole('button', 'Create folder').tap()
  await screen.getByRole('link', folder, { exact: true }).waitFor()
  return folder
}

describe('interface interactions', () => {
  test('the hydrated password toggle restores a masked field', async ({
    app,
    browser,
    screen,
  }) => {
    await app.open('/login')

    await screen.getByRole('button', 'Show password').tap()
    await browser.locator('#login-password[type=text]').waitFor()

    await screen.getByRole('button', 'Hide password').tap()

    await expect(
      browser.locator('#login-password[type=password]'),
    ).toBeVisible()
    await expect(screen.getByRole('button', 'Show password')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  test('a rejected login identifies the affected fields and offers another attempt', async ({
    app,
    screen,
  }) => {
    await app.open('/login')
    await screen
      .getByLabel('Username')
      .fill('unknown-' + randomUUID().slice(0, 8))
    await screen
      .getByLabel('Password', { exact: true })
      .fill(secrets.get('memberPassword'))

    await screen.getByRole('button', 'Sign in').tap()

    await expect(screen.getByRole('alert')).toContainText(
      'Invalid username or password',
    )
    await expect(screen.getByLabel('Username')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    await expect(screen.getByRole('button', 'Sign in')).toBeVisible()
  })

  test(
    'mobile navigation opens the chosen workspace and closes its drawer',
    { session: 'owner' },
    async ({ app, browser, screen }) => {
      await browser.setViewport({ width: 390, height: 844 })
      await app.open(storage)
      await screen.getByRole('button', 'Toggle navigation').tap()

      await screen.getByRole('link', 'Shared links', { exact: true }).tap()

      await expect(screen.getByRole('heading', 'Shared links')).toBeVisible()
      await expect(
        screen.getByRole('button', 'Toggle navigation'),
      ).toHaveAttribute('aria-expanded', 'false')
      await expect(
        screen.getByRole('link', 'Shared links', { exact: true }),
      ).toBeHidden()
    },
  )

  test(
    'Escape closes a keyboard-opened file dialog and returns focus to its button',
    { session: 'owner' },
    async ({ app, browser, screen }) => {
      await app.open(storage)
      const actions = screen.getByRole('button', 'Actions for handoff.txt')
      await actions.focus()
      await browser.keyboard.press('Enter')
      const modal = screen.getByRole('dialog', 'File actions')
      await modal.waitFor()

      await browser.keyboard.press('Escape')

      await expect(modal).toBeHidden()
      await expect(actions).toBeFocused()
    },
  )

  test(
    'the search shortcut accepts a query without selecting files',
    { session: 'owner' },
    async ({ app, browser, screen }) => {
      await app.open(storage)
      await screen.getByRole('button', 'Display preferences').focus()
      await browser.keyboard.press('/')
      const search = screen.getByRole('searchbox', 'Search files')
      await search.pressSequentially('handoff.txt')
      await browser.keyboard.press('Control+a')
      await browser.keyboard.press('Enter')

      await expect(screen.getByRole('heading', 'Search results')).toBeVisible()
      await expect(
        screen.getByRole('link', 'handoff.txt', { exact: true }),
      ).toBeVisible()
      await expect(search).toHaveValue('handoff.txt')
      await expect(
        screen.getByRole('checkbox', 'Select handoff.txt'),
      ).not.toBeChecked()
    },
  )

  test(
    'a secondary click opens the file menu for the targeted row',
    { session: 'owner' },
    async ({ app, screen }) => {
      await app.open(storage)
      const file = screen.getByRole('link', 'handoff.txt', { exact: true })

      await file.secondaryTap()

      const dialog = screen.getByRole('dialog', 'File actions')
      await expect(
        dialog.getByText('handoff.txt', { exact: true }),
      ).toBeVisible()
      await expect(
        dialog.getByRole('button', 'Create share link'),
      ).toBeVisible()
    },
  )

  for (const width of [1280, 390]) {
    test(
      'the fullscreen gallery moves between readable images at ' + width + 'px',
      { session: 'owner' },
      async ({ app, browser, screen }) => {
        await browser.setViewport({ width, height: width === 390 ? 844 : 800 })
        await app.open(storage)
        const folder = await createFolder(screen)
        await screen.getByRole('link', folder, { exact: true }).tap()
        await screen.getByRole('heading', folder, { level: 1 }).waitFor()
        const png = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ2YAAAAASUVORK5CYII=',
          'base64',
        )
        await uploadFiles(screen, [
          { name: '01-first.png', mimeType: 'image/png', buffer: png },
          {
            name: '02-notes.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('Field notes.'),
          },
          {
            name: '03-invalid.png',
            mimeType: 'application/octet-stream',
            buffer: Buffer.from('Not image bytes'),
          },
          { name: '04-final.png', mimeType: 'image/png', buffer: png },
        ])
        await screen.getByRole('link', '02-notes.txt', { exact: true }).tap()
        await screen.getByText('Field notes.', { exact: true }).waitFor()
        const gallery = screen.getByRole('navigation', 'Image navigation')
        const hiddenInDocument = !(await gallery.isVisible())
        await screen.getByRole('button', 'Close Preview').tap()
        await screen.getByRole('link', '01-first.png', { exact: true }).tap()
        await gallery.getByRole('button', 'Fullscreen', { exact: true }).tap()
        await gallery
          .getByRole('button', 'Exit fullscreen', { exact: true })
          .waitFor()
        const active = await browser.evaluate(
          () =>
            document.fullscreenElement?.hasAttribute('data-gallery-surface') ===
            true,
        )

        if (width === 390)
          await gallery.getByRole('button', 'Next', { exact: true }).tap()
        else await browser.keyboard.press('ArrowRight')
        await screen.getByRole('img', '04-final.png', { exact: true }).waitFor()
        const atEnd = await gallery
          .getByRole('button', 'Next', { exact: true })
          .isDisabled()
        await gallery.getByRole('button', 'Previous', { exact: true }).tap()
        await screen.getByRole('img', '01-first.png', { exact: true }).waitFor()
        await gallery
          .getByRole('button', 'Exit fullscreen', { exact: true })
          .tap()
        await gallery
          .getByRole('button', 'Fullscreen', { exact: true })
          .waitFor()

        expect(hiddenInDocument).toBe(true)
        expect(active).toBe(true)
        expect(atEnd).toBe(true)
        expect(
          await browser.evaluate(() => document.fullscreenElement === null),
        ).toBe(true)
        await expect(
          gallery.getByRole('button', 'Previous', { exact: true }),
        ).toBeDisabled()
      },
    )
  }
  test(
    'dropping a file on a folder moves it after confirmation',
    { session: 'owner' },
    async ({ app, screen }) => {
      await app.open(storage)
      const workspace = await createFolder(screen)
      await screen.getByRole('link', workspace, { exact: true }).tap()
      await screen.getByRole('heading', workspace, { level: 1 }).waitFor()
      const folder = await createFolder(screen)
      const payload = filePayload(
        'dragged.txt',
        'Drag destination check.',
        'text/plain',
      )
      await uploadFiles(screen, [payload])
      const source = screen.getByRole('link', payload.name, { exact: true })
      const destination = screen.getByRole('link', folder, { exact: true })

      await source.dragTo(destination)
      const move = screen.getByRole('dialog', 'Move items')
      await move.getByRole('button', 'Move', { exact: true }).tap()
      await source.waitFor({ state: 'hidden' })
      await destination.tap()
      await screen.getByRole('heading', folder, { level: 1 }).waitFor()

      await expect(
        screen.getByRole('link', payload.name, { exact: true }),
      ).toBeVisible()
    },
  )
})
