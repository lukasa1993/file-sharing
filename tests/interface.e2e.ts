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

  test(
    'preview navigation moves to the adjacent file in the current folder',
    { session: 'owner' },
    async ({ app, screen }) => {
      await app.open(storage)
      const folder = await createFolder(screen)
      await screen.getByRole('link', folder, { exact: true }).tap()
      await screen.getByRole('heading', folder, { level: 1 }).waitFor()
      const files = [
        {
          name: '01-notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('First page.'),
        },
        {
          name: '02-notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Second page.'),
        },
      ]
      await uploadFiles(screen, files)
      await screen.getByRole('link', '01-notes.txt', { exact: true }).tap()
      const gallery = screen.getByRole('navigation', 'Preview navigation')
      await screen.getByText('First page.', { exact: true }).waitFor()

      await gallery.getByRole('button', 'Next').tap()

      await expect(screen.getByRole('heading', '02-notes.txt')).toBeVisible()
      await expect(
        screen.getByText('Second page.', { exact: true }),
      ).toBeVisible()
      await expect(gallery.getByRole('button', 'Next')).toBeDisabled()
    },
  )
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
