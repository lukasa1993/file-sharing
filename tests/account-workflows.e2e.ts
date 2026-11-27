import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { beforeEach, describe, test } from '@e2e-dev/web'
import { expect, secrets, type TestFixtures } from 'e2e'
import { createMember } from './helpers/member.ts'

type Screen = TestFixtures['screen']

async function form(screen: Screen, name: string) {
  await screen.getByText(name, { exact: true, visible: true }).tap()
  return screen.getByRole('form', name, { exact: true })
}

async function memberLogin(
  app: TestFixtures['app'],
  screen: Screen,
  name: string,
  password: 'memberPassword' | 'replacementPassword',
) {
  await app.open('/login')
  await screen.getByLabel('Username').fill(name)
  await screen
    .getByLabel('Password', { exact: true })
    .fill(secrets.get(password))
  await screen.getByRole('button', 'Sign in').tap()
  await screen.getByRole('navigation', 'Storage').waitFor()
}

describe('accounts and administration', { session: 'owner' }, () => {
  beforeEach(async ({ app }) => {
    await app.open('/_/files?mount=e2e')
  })

  test('a member can list the storage granted to their group', async ({
    app,
    browser,
    screen,
  }) => {
    const suffix = randomUUID().slice(0, 8)
    const name = 'member-' + suffix
    const group = 'Readers-' + suffix
    await app.open('/_/admin')
    await createMember(screen, name)
    const create = await form(screen, 'Create group')
    await create.getByLabel('Group name').fill(group)
    await create.getByRole('button', 'Create group').tap()
    await screen.getByRole('row').filter({ hasText: group }).waitFor()
    const membership = await form(screen, 'Edit group membership')
    await membership
      .getByLabel('Group', { exact: true })
      .selectOption({ label: group })
    await membership
      .getByLabel('User', { exact: true })
      .selectOption({ label: name })
    await membership.getByRole('button', 'Save membership').tap()
    await screen
      .getByRole('row')
      .filter({ hasText: group })
      .filter({ hasText: name })
      .waitFor()
    const grant = await form(screen, 'Change a directory grant')
    await grant
      .getByLabel('Principal')
      .selectOption({ label: group + ' (group)' })
    await grant
      .getByLabel('Permission', { exact: true })
      .selectOption({ label: 'list' })
    await grant.getByLabel('Effect').selectOption({ label: 'allow' })
    await grant.getByRole('button', 'Save grant').tap()
    await screen
      .getByRole('row')
      .filter({ hasText: group })
      .filter({ hasText: 'allow' })
      .waitFor()
    await browser.clearCookies()

    await memberLogin(app, screen, name, 'memberPassword')

    await expect(screen.getByText('handoff.txt', { exact: true })).toBeVisible()
    await expect(screen.getByRole('link', 'Administration')).toHaveCount(0)
  })

  test('the member can sign in using their newly changed password', async ({
    app,
    browser,
    screen,
  }) => {
    const username = 'password-' + randomUUID().slice(0, 8)
    await app.open('/_/admin')
    await createMember(screen, username)
    await browser.clearCookies()
    await memberLogin(app, screen, username, 'memberPassword')
    await app.open('/_/account')
    const change = await form(screen, 'Change password')
    await change
      .getByLabel('Current password')
      .fill(secrets.get('memberPassword'))
    await change
      .getByLabel('New password')
      .fill(secrets.get('replacementPassword'))

    await change.getByRole('button', 'Update password').tap()
    await screen.getByRole('heading', 'Sign in').waitFor()
    await memberLogin(app, screen, username, 'replacementPassword')
    await app.open('/_/account')

    await expect(
      screen
        .getByRole('region', 'Profile')
        .getByText(username, { exact: true }),
    ).toBeVisible()
    await expect(screen.getByRole('heading', 'Sessions')).toBeVisible()
  })

  test('signing out a session immediately returns that browser to sign-in', async ({
    app,
    browser,
    screen,
  }) => {
    const username = 'session-' + randomUUID().slice(0, 8)
    await app.open('/_/admin')
    await createMember(screen, username)
    await browser.clearCookies()
    await memberLogin(app, screen, username, 'memberPassword')
    await app.open('/_/account')

    await screen
      .getByRole('row')
      .filter({ hasText: '(this session)' })
      .getByRole('button', 'Sign out session')
      .tap()
    await screen
      .getByRole('dialog', 'Confirm action')
      .getByRole('button', 'Confirm', { exact: true })
      .tap()

    await expect(screen.getByRole('heading', 'Sign in')).toBeVisible()
  })

  test(
    'revoking a list-only token stops API access immediately',
    { trace: 'off', video: 'off' },
    async ({ app, browser, screen }) => {
      const label = 'reader-' + randomUUID().slice(0, 8)
      await app.open('/_/account')
      const issue = await form(screen, 'Create API token')
      await issue.getByLabel('Label').fill(label)
      await issue.getByLabel('Permissions').selectOption({ label: 'List only' })
      await issue.getByLabel('Expires in days').fill('1')
      await issue.getByRole('button', 'Create token').tap()
      const result = screen.getByRole('dialog', 'New API token')
      await result.getByRole('button', 'Copy token').tap()
      await result.getByRole('button', 'Done').tap()
      const row = screen.getByRole('row').filter({ hasText: label })
      await row.waitFor()
      // Keep the issued credential in the browser; assertions and runner artifacts receive only status codes.
      const original = await browser.evaluate(async () => {
        const headers = {
          Authorization: 'Bearer ' + (await navigator.clipboard.readText()),
        }
        const options = { headers, credentials: 'omit' } as const
        const list = await fetch('/_/api/v1/entries?mount=e2e', options)
        const file = await fetch(
          '/_/download?mount=e2e&path=handoff.txt',
          options,
        )
        return [list.status, file.status]
      })

      await row.getByRole('button', 'Revoke').tap()
      await screen
        .getByRole('dialog', 'Confirm action')
        .getByRole('button', 'Confirm', { exact: true })
        .tap()
      await row.waitFor({ state: 'hidden' })
      const after = await browser.evaluate(async () => {
        const headers = {
          Authorization: 'Bearer ' + (await navigator.clipboard.readText()),
        }
        const response = await fetch('/_/api/v1/entries?mount=e2e', {
          headers,
          credentials: 'omit',
        })
        await navigator.clipboard.writeText('')
        return response.status
      })

      expect(original).toEqual([200, 403])
      expect(after).toBe(401)
      await expect(row).toHaveCount(0)
    },
  )

  test('an administrator can save workspace branding and trash retention', async ({
    app,
    screen,
  }) => {
    const workspace = 'Workspace ' + randomUUID().slice(0, 8)
    await app.open('/_/admin')
    const settings = await form(screen, 'Brand and retention')

    const originalBrand = await settings
      .getByLabel('Workspace name')
      .inputValue()
    const originalDays = await settings
      .getByLabel('Trash retention (days)')
      .inputValue()
    try {
      await settings.getByLabel('Workspace name').fill(workspace)
      await settings.getByLabel('Trash retention (days)').fill('28')
      await settings.getByRole('button', 'Save settings').tap()
      await settings.waitFor({ state: 'hidden' })
      const saved = await form(screen, 'Brand and retention')

      await expect(saved.getByLabel('Workspace name')).toHaveValue(workspace)
      await expect(saved.getByLabel('Trash retention (days)')).toHaveValue('28')
    } finally {
      await app.open('/_/admin')
      const restore = await form(screen, 'Brand and retention')
      await restore.getByLabel('Workspace name').fill(originalBrand)
      await restore.getByLabel('Trash retention (days)').fill(originalDays)
      await restore.getByRole('button', 'Save settings').tap()
      await restore.waitFor({ state: 'hidden' })
    }
  })

  test('a storage root inherits the workspace retention after its override is cleared', async ({
    app,
    screen,
  }) => {
    await app.open('/_/admin')
    const custom = await form(screen, 'Set storage trash retention')
    await custom
      .getByLabel('Retention in days (blank for workspace default)')
      .fill('14')
    await custom.getByRole('button', 'Save retention').tap()
    await screen.getByRole('cell', '14 days', { exact: true }).waitFor()

    const restore = await form(screen, 'Set storage trash retention')
    await restore
      .getByLabel('Retention in days (blank for workspace default)')
      .fill('')
    await restore.getByRole('button', 'Save retention').tap()

    await expect(
      screen.getByRole('cell').filter({ hasText: 'days (workspace default)' }),
    ).toBeVisible()
  })

  test('an administrator can export current server diagnostics from the activity view', async ({
    app,
    screen,
    browser,
  }) => {
    await app.open('/_/admin#activity')

    const download = await browser.waitForDownload(() =>
      screen.getByRole('link', 'Download diagnostics').tap(),
    )
    const report = JSON.parse(
      await readFile(download.absolutePath, 'utf8'),
    ) as {
      uptimeSeconds: number
      residentBytes: number
      activeTransfers: number
      transferBytesPerSecond: number
    }

    expect(download.suggestedFilename).toBe('lshare-diagnostics.json')
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0)
    expect(report.residentBytes).toBeGreaterThan(0)
    expect(report.activeTransfers).toBeGreaterThanOrEqual(0)
    expect(report.transferBytesPerSecond).toBeGreaterThanOrEqual(0)
    await expect(
      screen.getByRole('heading', 'Server configuration'),
    ).toBeVisible()
    await expect(
      screen.getByText('Maximum upload chunk', { exact: true }),
    ).toBeVisible()
    await expect(screen.getByRole('heading', 'Live transfers')).toBeVisible()
    await expect(screen.getByRole('heading', 'Recent requests')).toBeVisible()
    await expect(screen.getByRole('heading', 'Activity log')).toBeVisible()
  })
  test('the assigned upload quota applies inside a member’s private home', async ({
    app,
    browser,
    screen,
  }) => {
    const suffix = randomUUID().slice(0, 8)
    const name = 'quota-' + suffix
    const home = 'private-' + suffix
    await screen.getByRole('button', 'New folder', { exact: true }).tap()
    const folder = screen.getByRole('dialog', 'New folder')
    await folder.getByLabel('Name').fill(home)
    await folder.getByRole('button', 'Create folder').tap()
    await screen
      .getByRole('main')
      .getByRole('link', home, { exact: true })
      .waitFor()
    await app.open('/_/admin')
    await createMember(screen, name)
    const assign = await form(screen, 'Assign a private home')
    await assign
      .getByLabel('User', { exact: true })
      .selectOption({ label: name })
    await assign.getByLabel('Existing folder path').fill(home)
    await assign.getByRole('button', 'Assign home').tap()
    await screen
      .getByRole('row')
      .filter({ hasText: name })
      .filter({ hasText: home })
      .waitFor()
    const quota = await form(screen, 'Set upload quota')
    await quota
      .getByLabel('User', { exact: true })
      .selectOption({ label: name })
    await quota.getByLabel('Maximum bytes (blank for unlimited)').fill('3')
    await quota.getByRole('button', 'Save quota').tap()
    await screen
      .getByRole('row')
      .filter({ hasText: name })
      .filter({ hasText: '3 B' })
      .waitFor()
    await browser.clearCookies()
    await memberLogin(app, screen, name, 'memberPassword')
    await screen.getByRole('heading', home, { exact: true }).waitFor()

    const [result] = await Promise.all([
      browser.waitForResponse({ method: 'POST', url: '**/_/uploads' }),
      screen.getByLabel('Choose files to upload').setInputFiles({
        name: 'over-quota.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('four'),
      }),
    ])

    expect(result.status).toBe(413)
    await expect(
      screen.getByText('Upload capacity exceeded.', { exact: false }),
    ).toBeVisible()
  })
  test('an administrator can create a group from the native form when scripts are unavailable', async ({
    app,
    screen,
    browser,
  }) => {
    const group = 'Native-' + randomUUID().slice(0, 8)
    await browser.route('**/assets/*.js', (route) => route.abort())
    await app.open('/_/admin')
    const create = await form(screen, 'Create group')
    await create.getByLabel('Group name').fill(group)

    await create.getByRole('button', 'Create group').tap()

    await expect(screen.getByRole('heading', 'Administration')).toBeVisible()
    await expect(
      screen.getByRole('row').filter({ hasText: group }),
    ).toBeVisible()
  })
  test(
    'the native account form can confirm issuance without exposing the token again on return',
    { trace: 'off', video: 'off' },
    async ({ app, browser, screen }) => {
      const label = 'native-reader-' + randomUUID().slice(0, 8)
      await browser.route('**/assets/*.js', (route) => route.abort())
      await app.open('/_/account')
      const create = await form(screen, 'Create API token')
      await create.getByLabel('Label').fill(label)
      await create.getByLabel('Expires in days').fill('1')
      await create.getByRole('button', 'Create token').tap()
      const issued = screen.getByRole('dialog', 'New API token')
      await issued.getByText('Show token', { exact: true }).waitFor()

      await issued.getByRole('button', 'Done').tap()

      await expect(
        screen.getByRole('row').filter({ hasText: label }),
      ).toBeVisible()
      await expect(issued).toHaveCount(0)
    },
  )
})
