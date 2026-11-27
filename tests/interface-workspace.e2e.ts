import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, test, type Browser } from '@e2e-dev/web'
import { expect, secrets, type TestFixtures } from 'e2e'
import { createMember } from './helpers/member.ts'
import { downloadFile, filePayload } from './helpers/transfer.ts'

const root = '/_/files?mount=e2e'
const folderUrl = (folder: string) =>
  root + '&path=' + encodeURIComponent(folder)
type App = TestFixtures['app']
type Screen = TestFixtures['screen']

async function seedDirectories(
  browser: Browser,
  path: string[],
  names: string[],
) {
  for (let at = 0; at < names.length; at += 16) {
    await browser.evaluate(
      async ({ path, batch }) => {
        const csrf = document.querySelector<HTMLMetaElement>(
          'meta[name=csrf-token]',
        )?.content
        if (!csrf) throw new Error('Sign in before preparing the folder.')
        await Promise.all(
          batch.map(async (name) => {
            const result = await fetch('/_/api/v1/files/operations', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrf,
              },
              body: JSON.stringify({
                operation: 'createDir',
                refs: [{ mountId: 'e2e', segments: path }],
                name,
              }),
            })
            if (!result.ok)
              throw new Error(
                'Could not prepare folder (HTTP ' + result.status + ').',
              )
          }),
        )
        return true
      },
      { path, batch: names.slice(at, at + 16) },
    )
  }
}
async function sampleFolder(app: App, browser: Browser, names: string[]) {
  const folder = 'Workspace ' + randomUUID().slice(0, 8)
  await app.open(root)
  await seedDirectories(browser, [], [folder])
  await seedDirectories(browser, [folder], names)
  await app.open(folderUrl(folder))
  return folder
}
function box(screen: Screen, name: string) {
  return screen.getByRole('checkbox', 'Select ' + name, { exact: true })
}
function link(screen: Screen, name: string) {
  return screen.getByRole('link', name, { exact: true })
}

describe('working across the file workspace', { session: 'owner' }, () => {
  test('clearing on the previous page also clears selections beyond its 100 visible rows', async ({
    app,
    browser,
    screen,
  }) => {
    const names = Array.from(
      { length: 101 },
      (_, i) => 'Folder ' + String(i).padStart(3, '0'),
    )
    await sampleFolder(app, browser, names)
    await box(screen, 'Folder 000').check()
    await screen
      .getByRole('navigation', 'File pages')
      .getByRole('link', 'Next')
      .tap()
    await box(screen, 'Folder 100').check()
    await screen.getByText('2 selected', { exact: true }).waitFor()
    await browser.reload()
    await screen.getByText('2 selected', { exact: true }).waitFor()
    await screen
      .getByRole('navigation', 'File pages')
      .getByRole('link', 'Previous')
      .tap()
    await box(screen, 'Folder 000').waitFor()
    const firstWasSelected = await box(screen, 'Folder 000').isChecked()

    await screen.getByRole('button', 'Clear', { exact: true }).tap()
    await screen
      .getByRole('navigation', 'File pages')
      .getByRole('link', 'Next')
      .tap()

    expect(firstWasSelected).toBe(true)
    await expect(box(screen, 'Folder 100')).not.toBeChecked()
    await expect(
      screen.getByRole('button', 'Clear', { exact: true }),
    ).toBeHidden()
  })

  test('reversing a keyboard range contracts it back toward the original focused row', async ({
    app,
    browser,
    screen,
  }) => {
    await sampleFolder(app, browser, ['One', 'Two', 'Three'])
    await link(screen, 'One').focus()
    await browser.keyboard.press('ArrowUp')
    await browser.keyboard.press('Shift+ArrowDown')
    await browser.keyboard.press('Shift+ArrowDown')

    await browser.keyboard.press('Shift+ArrowUp')

    await expect(link(screen, 'Three')).toBeFocused()
    await expect(box(screen, 'One')).toBeChecked()
    await expect(box(screen, 'Three')).toBeChecked()
    await expect(box(screen, 'Two')).not.toBeChecked()
    await expect(screen.getByText('2 selected', { exact: true })).toBeVisible()
  })

  test('select all prepares every visible entry for a single action', async ({
    app,
    browser,
    screen,
  }) => {
    await sampleFolder(app, browser, ['First', 'Second'])
    await link(screen, 'First').focus()
    await browser.keyboard.press('Control+a')

    await screen.getByRole('button', 'Share', { exact: true }).tap()

    const editor = screen.getByRole('dialog', 'Share files')
    await expect(editor).toBeVisible()
    await expect(
      editor.getByText('First, Second', { exact: true }),
    ).toBeVisible()
  })

  test('canceling a pending clipboard paste leaves both folders untouched', async ({
    app,
    browser,
    screen,
  }) => {
    const folder = await sampleFolder(app, browser, [
      'Destination',
      'Work in progress',
    ])
    await link(screen, 'Work in progress').tap({ modifiers: ['Control'] })
    await link(screen, 'Work in progress').focus()
    await browser.keyboard.press('Control+x')
    await link(screen, 'Destination').tap()
    await screen.getByRole('heading', 'Destination', { level: 1 }).waitFor()
    await screen.getByRole('button', 'Display preferences').focus()
    await browser.keyboard.press('Control+v')
    const move = screen.getByRole('dialog', 'Move items')

    await move.getByRole('button', 'Cancel').tap()
    const stillEmpty = await screen
      .getByRole('heading', 'This folder is empty')
      .isVisible()
    await browser.back()
    await screen.getByRole('heading', folder, { level: 1 }).waitFor()

    expect(stillEmpty).toBe(true)
    await expect(link(screen, 'Work in progress')).toBeVisible()
  })

  test('Recent reopens a folder visited through workspace navigation', async ({
    app,
    browser,
    screen,
  }) => {
    const folder = await sampleFolder(app, browser, ['New collection'])
    await link(screen, 'New collection').tap()
    await screen.getByRole('heading', 'New collection', { level: 1 }).waitFor()
    await link(screen, 'Shared links').tap()
    await screen.getByRole('heading', 'Shared links', { level: 1 }).waitFor()

    await screen.getByRole('button', 'Recent', { exact: true }).tap()
    const recent = screen.getByRole('dialog', 'Recently opened')
    await recent
      .getByRole('link', 'e2e / ' + folder + ' / New collection', {
        exact: true,
      })
      .tap()

    await expect(
      screen.getByRole('heading', 'New collection', { level: 1 }),
    ).toBeVisible()
  })

  test('a member can start at their granted folders without opening a parent or sibling', async ({
    app,
    browser,
    screen,
  }) => {
    const parent = await sampleFolder(app, browser, [
      'Design review',
      'Releases',
      'Private drafts',
    ])
    await seedDirectories(
      browser,
      [parent, 'Design review'],
      ['Delivered artwork'],
    )
    const username = 'project-' + randomUUID().slice(0, 8)
    await app.open('/_/admin')
    await createMember(screen, username)
    const grantForm = screen.getByRole('form', 'Change a directory grant', {
      exact: true,
    })
    await screen.getByText('Change a directory grant', { exact: true }).tap()
    const principal = grantForm.getByLabel('Principal')
    await principal.selectOption({ label: username + ' (user)' })
    const userId = (await principal.inputValue()).slice('user:'.length)
    await browser.evaluate(
      async ({ userId, parent }) => {
        const csrf = document.querySelector<HTMLMetaElement>(
          'meta[name=csrf-token]',
        )?.content
        if (!csrf) throw new Error('Missing administrator form.')
        for (const folder of ['Design review', 'Releases']) {
          const response = await fetch('/_/api/v1/admin', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': csrf,
            },
            body: JSON.stringify({
              action: 'setGrant',
              subjectType: 'user',
              subjectId: userId,
              mountId: 'e2e',
              path: parent + '/' + folder,
              permission: 'list',
              effect: 'allow',
            }),
          })
          if (!response.ok)
            throw new Error('Could not grant access: HTTP ' + response.status)
        }
        return true
      },
      { userId, parent },
    )
    await browser.clearCookies()
    await app.open('/login')
    await screen.getByLabel('Username').fill(username)
    await screen
      .getByLabel('Password', { exact: true })
      .fill(secrets.get('memberPassword'))
    await screen.getByRole('button', 'Sign in', { exact: true }).tap()
    const storage = screen.getByRole('navigation', 'Storage')
    await storage.getByRole('link', 'Design review', { exact: true }).tap()
    await screen
      .getByRole('link', 'Delivered artwork', { exact: true })
      .waitFor()
    const forbidden = await browser.evaluate(
      async (parent) =>
        Promise.all(
          ['', parent, parent + '/Private drafts'].map(
            async (path) =>
              (
                await fetch(
                  '/_/files?' + new URLSearchParams({ mount: 'e2e', path }),
                )
              ).status,
          ),
        ),
      parent,
    )

    await storage.getByRole('link', 'Releases', { exact: true }).tap()

    await expect(
      screen.getByRole('heading', 'Releases', { level: 1 }),
    ).toBeVisible()
    await expect(
      screen.getByRole('link', 'Private drafts', { exact: true }),
    ).toHaveCount(0)
    await expect(
      screen
        .getByRole('navigation', 'Breadcrumb')
        .getByRole('link', parent, { exact: true }),
    ).toHaveCount(0)
    expect(forbidden).toEqual([403, 403, 403])
  })

  test('file details identify the selected entry and the size of its original bytes', async ({
    app,
    screen,
  }) => {
    const original = await readFile(
      new URL('./fixtures/handoff.txt', import.meta.url),
    )
    await app.open(root)
    await link(screen, 'handoff.txt').secondaryTap()

    await screen
      .getByRole('dialog', 'File actions')
      .getByRole('button', 'Details')
      .tap()

    const details = screen.getByRole('dialog', 'File details')
    await expect(
      details.getByText('/handoff.txt', { exact: true }),
    ).toBeVisible()
    await expect(
      details.getByText(original.byteLength + ' B', { exact: true }),
    ).toBeVisible()
    await expect(details.getByText('e2e', { exact: true })).toBeVisible()
  })

  test('a failed navigation keeps the open workspace available for a retry', async ({
    app,
    browser,
    screen,
  }) => {
    await app.open(root)
    const destination = link(screen, 'Shared links')
    const route = { method: 'GET', url: '**/_/shares' }
    await browser.route(route, (r) =>
      r.fulfill({
        status: 503,
        contentType: 'text/plain',
        body: 'Storage is starting',
      }),
    )
    await destination.tap()
    const failed = screen.getByRole('status')
    await failed.waitFor()
    await screen
      .getByText('Could not open this page (HTTP 503).', { exact: true })
      .waitFor()
    const oldContent = await link(screen, 'handoff.txt').isVisible()
    await browser.unroute(route)

    await destination.tap()

    expect(oldContent).toBe(true)
    await expect(
      screen.getByRole('heading', 'Shared links', { level: 1 }),
    ).toBeVisible()
  })

  test('retrying a folder form after a proxy failure preserves the entered name', async ({
    app,
    browser,
    screen,
  }) => {
    await app.open(root)
    const name = 'Retry ' + randomUUID().slice(0, 8)
    const route = { method: 'POST', url: '**/_/api/v1/files/operations' }
    await browser.route(route, (r) =>
      r.fulfill({
        status: 502,
        contentType: 'text/plain',
        body: 'Gateway temporarily unavailable',
      }),
    )
    await screen.getByRole('button', 'New folder').tap()
    const form = screen.getByRole('dialog', 'New folder')
    await form.getByLabel('Name').fill(name)
    await form.getByRole('button', 'Create folder').tap()
    await form
      .getByText('Request failed (HTTP 502).', { exact: true })
      .waitFor()
    const retained = await form.getByLabel('Name').inputValue()
    await browser.unroute(route)

    await form.getByRole('button', 'Create folder').tap()

    expect(retained).toBe(name)
    await expect(link(screen, name)).toBeVisible()
    await expect(form).toBeHidden()
  })

  test(
    'a live upload survives back and forward navigation and finishes with the original bytes',
    { timeout: 60000 },
    async ({ app, browser, screen }) => {
      const file = filePayload('in-flight.bin', Buffer.from([0, 1, 3, 7, 255]))
      await app.open(root)
      const reached = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>()
      const chunk = { method: 'PATCH', url: '**/_/uploads/*' }
      await browser.route(chunk, async (r) => {
        reached.resolve()
        await release.promise
        await r.continue()
      })
      try {
        await screen.getByRole('button', 'Upload files').setInputFiles(file)
        await reached.promise
        await screen.getByRole('button', 'Close Transfers').tap()
        await link(screen, 'Shared links').tap()
        await screen
          .getByRole('heading', 'Shared links', { level: 1 })
          .waitFor()
        await browser.back()
        await link(screen, 'handoff.txt').waitFor()
        await browser.forward()
        await screen
          .getByRole('heading', 'Shared links', { level: 1 })
          .waitFor()
        await screen.getByRole('button', /^Transfers/).tap()
        const job = screen.getByRole('group', file.name)
        await job.getByRole('button', 'Pause').waitFor()

        release.resolve()
        await job.getByRole('button', 'Dismiss').waitFor()
        await screen.getByRole('button', 'Close Transfers').tap()
        await browser.back()
        await link(screen, file.name).waitFor()
        const saved = await downloadFile(screen, browser, file.name)

        expect(saved.bytes.equals(file.buffer)).toBe(true)
      } finally {
        release.resolve()
        await browser.unroute(chunk)
      }
    },
  )
})
