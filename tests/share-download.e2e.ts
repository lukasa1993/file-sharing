import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, test } from '@e2e-dev/web'
import { credentials, expect } from 'e2e'

describe('file sharing', { tags: ['agent'] }, () => {
  test('a signed-out friend downloads the original file from the link an owner copied', async ({
    agent,
    app,
    browser,
    screen,
  }) => {
    const file = 'handoff.txt'
    const original = await readFile(
      new URL('./fixtures/handoff.txt', import.meta.url),
    )
    const alias = `handoff-${randomUUID()}`
    const owner = credentials.user('owner')

    await app.open('/login')
    await screen.getByLabel('Username').fill(owner.username)
    await screen.getByLabel('Password', { exact: true }).fill(owner.password)
    await screen.getByRole('button', 'Sign in').tap()
    await screen.getByText(file, { exact: true }).waitFor()

    await agent.act(
      'Create the public download page for {file} at alias {alias}, including the required confirmation that anyone who knows or guesses this link can access it.',
      {
        params: { file, alias },
      },
    )
    await agent.act('Copy the share URL for {alias} to the clipboard.', {
      params: { alias },
    })
    const link = new URL(
      await browser.evaluate(() => navigator.clipboard.readText()),
    )
    await browser.clearCookies()
    await app.open(link.pathname + link.search)
    const download = await browser.waitForDownload(() =>
      screen.getByRole('link', 'Download').tap(),
    )
    const received = await readFile(download.absolutePath)

    await expect(screen.getByRole('heading', file)).toBeVisible()
    expect(link.href).toBe(new URL('/' + alias, app.baseUrl).href)
    expect(download.suggestedFilename).toBe(file)
    expect(received.equals(original)).toBe(true)
  })
})
