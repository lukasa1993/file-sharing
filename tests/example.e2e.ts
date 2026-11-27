import { describe, test } from '@e2e-dev/web'
import { expect } from 'e2e'

describe('public entry', () => {
  test('opens the app for a signed-out visitor', async ({
    app,
    browser,
    request,
    screen,
  }) => {
    await app.open('/')
    const response = await request.get(await browser.url())

    expect(response).toBeOK()
    await expect(screen.getByRole('heading', 'Sign in')).toBeVisible()
  })
})
