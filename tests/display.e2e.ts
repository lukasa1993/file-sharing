import { describe, test } from '@e2e-dev/web'
import { expect } from 'e2e'

describe('workspace appearance', { session: 'owner' }, () => {
  test('keeps the chosen appearance on another page and on a fresh load', async ({
    app,
    browser,
    screen,
  }) => {
    await app.open('/_/files?mount=e2e')
    await screen.getByRole('button', 'Display preferences').tap()
    await screen.getByLabel('Appearance').selectOption({ value: 'dark' })
    await browser.locator('html[data-theme="dark"]').waitFor()

    await app.open('/_/account')
    await screen.getByRole('button', 'Display preferences').tap()
    await expect(screen.getByLabel('Appearance')).toHaveValue('dark')
    await expect(browser.locator('html')).toHaveAttribute('data-theme', 'dark')
  })
})
