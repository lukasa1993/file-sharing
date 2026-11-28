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

    const mark = await browser.evaluate(async () => {
      const logo = document.querySelector<HTMLImageElement>('img.brandmark')
      const favicon =
        document.querySelector<HTMLLinkElement>('link[rel="icon"]')
      if (!logo || !favicon) return false
      await logo.decode()
      return logo.naturalWidth > 0 && logo.src === favicon.href
    })

    expect(response).toBeOK()
    expect(mark).toBe(true)
    await expect(browser).toHaveTitle('Sign in · lshare')
    await expect(screen.getByRole('heading', 'Sign in')).toBeVisible()
  })
})
