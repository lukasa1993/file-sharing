import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseTar } from 'remix/tar-parser'
import { beforeEach, describe, test } from '@e2e-dev/web'
import { credentials, expect, secrets, type TestFixtures } from 'e2e'
import { folder, shareItem } from './helpers/share.ts'
import { createMember } from './helpers/member.ts'
import { signInOwner } from './helpers/owner.ts'

type Screen = TestFixtures['screen']
const sourceFile = 'handoff.txt'
const sourceBytes = () =>
  readFile(new URL('./fixtures/handoff.txt', import.meta.url))
const unique = (name: string) => name + '-' + randomUUID().slice(0, 12)
async function saveLink(
  screen: Screen,
  alias: string,
  access: 'public' | 'password' | 'authenticated',
  options: { landing?: boolean; upload?: boolean; edit?: boolean } = {},
) {
  await screen.getByRole('textbox', /^Link address/).fill(alias)
  await screen
    .getByLabel('Access', { exact: true })
    .selectOption({ value: access })
  if (options.landing)
    await screen.getByLabel('Open link as').selectOption({ value: 'landing' })
  if (access === 'public')
    await screen.getByRole('checkbox', /I confirm/).check()
  if (access === 'password')
    await screen.getByLabel('Share password').fill(secrets.get('sharePassword'))
  await screen
    .getByRole(
      'button',
      options.edit
        ? 'Save changes'
        : options.upload
          ? 'Create upload link'
          : 'Create link',
      { exact: true },
    )
    .tap()
  await screen.getByRole('dialog', 'Your link is ready').waitFor()
  await screen.getByRole('button', 'Done', { exact: true }).tap()
}

describe('sharing with recipients', { session: 'owner' }, () => {
  beforeEach(async ({ app, screen }) => {
    await app.open('/_/files?mount=e2e')
    await screen.getByRole('button', 'Actions for ' + sourceFile).waitFor()
  })

  test('a recipient browses a shared selection and downloads the original file', async ({
    screen,
    app,
    browser,
  }) => {
    const alias = unique('selection'),
      directory = unique('materials')
    await folder(screen, directory)
    await screen
      .getByRole('checkbox', 'Select ' + sourceFile, { exact: true })
      .check()
    await screen
      .getByRole('checkbox', 'Select ' + directory, { exact: true })
      .check()
    await screen.getByRole('button', 'Share', { exact: true }).tap()
    await saveLink(screen, alias, 'public')
    await browser.clearCookies()
    await app.open('/' + alias)
    await screen.getByRole('link', new RegExp(directory)).tap()
    const folderHeading = await screen
      .getByRole('heading', directory)
      .textContent()
    await screen.getByRole('link', 'Parent folder').tap()
    const names = await screen.getByRole('listitem').count()
    const download = await browser.waitForDownload(() =>
      screen.getByRole('link', /handoff\.txt/).tap(),
    )

    const archive = await browser.waitForDownload(() =>
      screen.getByRole('link', 'Download archive').tap(),
    )
    const inventory = new Map<string, Buffer>()
    await parseTar(await readFile(archive.absolutePath), async (entry) => {
      inventory.set(
        entry.name.replace(/\/$/, ''),
        Buffer.from(await entry.bytes()),
      )
    })

    await expect(screen.getByRole('heading', 'Shared files')).toBeVisible()
    expect(archive.suggestedFilename).toBe('shared-files.tar')
    expect([...inventory.keys()].sort()).toEqual([directory, sourceFile].sort())
    expect(inventory.get(sourceFile)?.equals(await sourceBytes())).toBe(true)
    expect(folderHeading).toBe(directory)
    expect(names).toBe(2)
    expect(download.suggestedFilename).toBe(sourceFile)
    expect(
      (await readFile(download.absolutePath)).equals(await sourceBytes()),
    ).toBe(true)
  })

  test('a protected folder opens the requested subfolder after a password retry', async ({
    screen,
    app,
    browser,
  }) => {
    const alias = unique('protected'),
      directory = unique('classes'),
      child = 'week-two'
    await folder(screen, directory)
    await screen.getByRole('link', directory, { exact: true }).tap()
    await folder(screen, child)
    await app.open('/_/files?mount=e2e')
    await shareItem(screen, directory)
    await saveLink(screen, alias, 'password')
    await browser.clearCookies()
    await app.open('/' + alias + '/' + child)
    await screen
      .getByLabel('Share password')
      .fill(credentials.user('owner').username)
    await screen.getByRole('button', 'Unlock share').tap()
    const rejection = await screen.getByRole('alert').textContent()
    await screen.getByLabel('Share password').fill(secrets.get('sharePassword'))
    await screen.getByRole('button', 'Unlock share').tap()

    await expect(screen.getByRole('heading', child)).toBeVisible()
    await expect(browser).toHaveURL('/' + alias + '/' + child)
    expect(rejection).toContain('Incorrect password')
  })

  test('a signed-in-only share delivers the requested file after recipient sign-in', async ({
    screen,
    app,
    browser,
  }) => {
    const alias = unique('private')
    const member = unique('member')
    await shareItem(screen, sourceFile)
    await saveLink(screen, alias, 'authenticated', { landing: true })
    await app.open('/_/admin')
    await createMember(screen, member)
    await browser.clearCookies()
    await app.open('/' + alias)
    await screen.getByRole('heading', 'Sign in').waitFor()
    const login = new URL(await browser.url())
    await screen.getByLabel('Username').fill(member)
    await screen
      .getByLabel('Password', { exact: true })
      .fill(secrets.get('memberPassword'))
    await screen.getByRole('button', 'Sign in').tap()
    const download = await browser.waitForDownload(() =>
      screen.getByRole('link', 'Download', { exact: true }).tap(),
    )

    await expect(screen.getByRole('heading', sourceFile)).toBeVisible()
    expect(login.pathname).toBe('/login')
    expect(login.searchParams.get('next')).toBe('/' + alias)
    expect(download.suggestedFilename).toBe(sourceFile)
    expect(
      (await readFile(download.absolutePath)).equals(await sourceBytes()),
    ).toBe(true)
  })

  test('an upload request receives the guest file without revealing the destination listing', async ({
    screen,
    app,
    browser,
  }) => {
    const alias = unique('drop'),
      directory = unique('submissions'),
      filename = 'response.txt'
    const bytes = Buffer.from('Submitted through the public upload request.\n')
    await folder(screen, directory)
    await shareItem(screen, directory, true)
    await saveLink(screen, alias, 'public', { upload: true })
    await browser.clearCookies()
    await app.open('/' + alias)
    const privateListing = await screen
      .getByRole('link', 'Download archive')
      .count()
    await screen
      .getByRole('button', 'Choose files')
      .setInputFiles({ name: filename, mimeType: 'text/plain', buffer: bytes })
    await screen.getByText(/Completed ·/).waitFor()
    await app.open('/' + alias)
    const visibleToNextVisitor = await screen
      .getByText(filename, { exact: true })
      .count()
    await signInOwner(app, screen)
    await screen.getByRole('link', directory, { exact: true }).tap()
    await screen.getByRole('button', 'Actions for ' + filename).tap()
    const download = await browser.waitForDownload(() =>
      screen.getByRole('button', 'Download', { exact: true }).tap(),
    )

    expect(privateListing).toBe(0)
    expect(visibleToNextVisitor).toBe(0)
    expect(download.suggestedFilename).toBe(filename)
    expect((await readFile(download.absolutePath)).equals(bytes)).toBe(true)
  })

  test('an owner can change an alias, disable it, re-enable it and revoke recipient access', async ({
    screen,
    app,
    request,
  }) => {
    const original = unique('lifecycle'),
      alias = unique('revised')
    await shareItem(screen, sourceFile)
    await saveLink(screen, original, 'public', { landing: true })
    await app.open('/_/shares')
    const record = (name: string) =>
      screen.getByRole('article').filter({
        has: screen.getByRole('checkbox', 'Select /' + name, { exact: true }),
      })
    await record(original).getByRole('button', 'Edit').tap()
    await saveLink(screen, alias, 'public', { edit: true })
    const previous = await request.get('/' + original)
    const delivered = await request.get('/' + alias + '?download=1')
    await delivered.text()
    await record(alias).getByRole('button', 'History').tap()
    const history = await screen
      .getByRole('dialog', 'Link history')
      .textContent()
    await screen
      .getByRole('dialog', 'Link history')
      .getByRole('button', 'Close Link history')
      .tap()
    await record(alias).getByRole('button', 'Disable').tap()
    await record(alias).getByRole('button', 'Enable').waitFor()
    const disabled = await request.get('/' + alias)
    await record(alias).getByRole('button', 'Enable').tap()
    await record(alias).getByRole('button', 'Disable').waitFor()
    const active = await request.get('/' + alias)
    await record(alias).getByRole('button', 'Revoke').tap()
    await screen.getByRole('button', 'Confirm', { exact: true }).tap()
    await screen.getByText('Link revoked.', { exact: true }).waitFor()
    const revoked = await request.get('/' + alias)

    expect(previous.status).toBe(404)
    expect(history).toContain('/' + original)
    expect(history).toContain('/' + alias)
    expect(delivered.status).toBe(200)
    expect(history).toContain('1 transfer request')
    expect(history).toContain('served')
    expect(history).toContain('Last transfer')
    expect(disabled.status).toBe(404)
    expect(active.status).toBe(200)
    expect(revoked.status).toBe(404)
    await expect(record(alias)).toHaveCount(0)
  })
  test('changing a link target delivers the replacement file at the same recipient URL', async ({
    screen,
    app,
    browser,
  }) => {
    const alias = unique('revision')
    const replacement = unique('updated') + '.txt'
    const bytes = Buffer.from('Revised file for existing recipients.\n')
    await screen.getByRole('button', 'Upload files').setInputFiles({
      name: replacement,
      mimeType: 'text/plain',
      buffer: bytes,
    })
    await screen.getByText(/Completed ·/).waitFor()
    await screen.getByRole('button', 'Close Transfers').tap()
    await screen
      .getByRole('button', 'Actions for ' + replacement, { exact: true })
      .waitFor()
    await shareItem(screen, sourceFile)
    await saveLink(screen, alias, 'public', { landing: true })
    await app.open('/_/shares')
    await screen
      .getByRole('article')
      .filter({
        has: screen.getByRole('checkbox', 'Select /' + alias, { exact: true }),
      })
      .getByRole('button', 'Edit')
      .tap()
    await screen.getByLabel('Change or reconfirm shared items').check()
    await screen.getByLabel('Path in storage').fill('/' + replacement)
    await saveLink(screen, alias, 'public', { edit: true })
    await browser.clearCookies()
    await app.open('/' + alias)
    const download = await browser.waitForDownload(() =>
      screen.getByRole('link', 'Download', { exact: true }).tap(),
    )

    await expect(screen.getByRole('heading', replacement)).toBeVisible()
    expect(download.suggestedFilename).toBe(replacement)
    expect((await readFile(download.absolutePath)).equals(bytes)).toBe(true)
  })
})
