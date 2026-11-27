import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from '@e2e-dev/web'
import { expect, secrets, type TestFixtures } from 'e2e'
import { addressFor, type Mailbox } from './mailbox.ts'

type Screen = TestFixtures['screen']

async function verify(screen: Screen, mailbox: Mailbox) {
  await screen.getByLabel('Email address').fill(addressFor(mailbox))
  await screen.getByRole('button', 'Send verification code').tap()
  await screen
    .getByLabel('Verification code')
    .fill(secrets.get(mailbox === 'owner' ? 'ownerCode' : 'senderCode'))
  await screen.getByRole('button', 'Verify email').tap()
}

async function createLink(
  screen: Screen,
  kind: 'file' | 'request',
  password = false,
) {
  const dialog = screen.getByRole(
    'dialog',
    kind === 'file' ? 'Share file' : 'Request files',
  )
  if (password) {
    await dialog
      .getByLabel('Who can download')
      .selectOption({ value: 'password' })
    await dialog
      .getByLabel('Link password')
      .fill(secrets.get('cloudLinkPassword'))
  }
  await dialog
    .getByRole(
      'button',
      kind === 'file' ? 'Create share link' : 'Create upload request',
    )
    .tap()
  const created = screen.getByRole('dialog', 'Link ready')
  const url = await created.getByLabel('Share this link').inputValue()
  await created.getByRole('button', 'Close').tap()
  return new URL(url).pathname
}

test.setup(
  'verify a disposable owner by email',
  { sessions: ['cloud-owner'] },
  async ({ app, screen, session }) => {
    await app.open('/')
    await screen.getByLabel('Email address').waitFor()
    await app.screenshot('cloud-sign-in')

    await verify(screen, 'owner')
    await screen.getByRole('heading', 'Your files').waitFor()
    await app.screenshot('cloud-workspace')
    await expect(screen.getByRole('heading', 'Your files')).toBeVisible()
    await session.save('cloud-owner')
  },
)

describe('Cloudflare file handoff', { session: 'cloud-owner' }, () => {
  test('a public recipient saves the original bytes from direct object storage', async ({
    app,
    browser,
    screen,
  }) => {
    const origin = process.env.E2E_STORAGE_ORIGIN
    if (!origin)
      throw new Error(
        'The fixture must declare its separate object-storage origin.',
      )
    const name = 'Field notes – résumé.bin'
    // Cross the production 8 MiB part boundary and verify both ranges survive in order.
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 59, 0xe9)
    bytes.fill(0x7f, 8 * 1024 * 1024)
    await app.open('/')
    const directory = await mkdtemp(join(tmpdir(), 'lshare-cloud-pick-'))
    let uploadStatus: number
    try {
      const source = join(directory, name)
      await writeFile(source, bytes)
      const [upload] = await Promise.all([
        browser.waitForResponse(
          { method: 'PUT', url: origin + '/**' },
          { timeout: 30000 },
        ),
        screen.getByLabel('Choose files').setInputFiles(source),
      ])
      uploadStatus = upload.status
      await screen
        .getByRole('status')
        .filter({ hasText: 'Uploaded' })
        .waitFor({ timeout: 30000 })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
    const entry = screen
      .getByRole('listitem')
      .filter({ has: screen.getByText(name, { exact: true }) })
      .filter({ has: screen.getByRole('button', 'Share') })
    await entry.getByRole('button', 'Share').tap()
    const path = await createLink(screen, 'file')
    await browser.clearCookies()
    await app.open(path)
    await screen.getByRole('heading', name).waitFor()
    await app.screenshot('cloud-shared-file')

    const [storage, saved] = await Promise.all([
      browser.waitForResponse(
        { method: 'GET', url: origin + '/**' },
        { timeout: 30000 },
      ),
      browser.waitForDownload(() =>
        screen.getByRole('link', 'Download file').tap(),
      ),
    ])

    expect(uploadStatus).toBe(200)
    expect(storage.status).toBe(200)
    expect(saved.suggestedFilename).toBe(name)
    expect((await readFile(saved.absolutePath)).equals(bytes)).toBe(true)
  })

  test('a password recipient can retry an incorrect password and download using the native form', async ({
    app,
    browser,
    screen,
  }) => {
    const name = 'Design brief.txt'
    const bytes = Buffer.from('Private file delivered through a password link.')
    await app.open('/')
    await screen
      .getByLabel('Choose files')
      .setInputFiles({ name, mimeType: 'text/plain', buffer: bytes })
    const entry = screen
      .getByRole('listitem')
      .filter({ has: screen.getByText(name, { exact: true }) })
      .filter({ has: screen.getByRole('button', 'Share') })
    await entry.getByRole('button', 'Share').tap()
    const path = await createLink(screen, 'file', true)
    await browser.clearCookies()
    await app.open(path)
    await screen.getByLabel('Link password').fill(secrets.get('wrongPassword'))
    await screen.getByRole('button', 'Download file').tap()
    await screen
      .getByRole('alert')
      .filter({ hasText: 'Incorrect password' })
      .waitFor()
    await screen
      .getByLabel('Link password')
      .fill(secrets.get('cloudLinkPassword'))

    const saved = await browser.waitForDownload(() =>
      screen.getByRole('button', 'Download file').tap(),
    )

    expect(saved.suggestedFilename).toBe(name)
    expect((await readFile(saved.absolutePath)).equals(bytes)).toBe(true)
  })

  test('a withdrawn upload request is unavailable to a new visitor', async ({
    app,
    browser,
    screen,
  }) => {
    await app.open('/')
    await screen.getByRole('button', 'Request files').tap()
    const path = await createLink(screen, 'request')
    const row = screen
      .getByRole('listitem')
      .filter({ has: screen.getByText(path, { exact: true }) })

    await row.getByRole('button', 'Withdraw').tap()
    await screen
      .getByRole('dialog', 'Withdraw link?')
      .getByRole('button', 'Withdraw link')
      .tap()
    await screen.getByText('Link withdrawn.', { exact: true }).waitFor()
    await browser.clearCookies()
    await app.open(path)

    await expect(screen.getByRole('alert')).toContainText('unavailable')
    await expect(screen.getByLabel('Choose files')).toBeHidden()
  })

  test('a verified sender delivers a file through an upload request without seeing the owner’s collection', async ({
    app,
    screen,
    browser,
  }) => {
    const name = 'Project notes.txt'
    await browser.setViewport({ width: 390, height: 844 })
    await app.open('/')
    await screen.getByRole('button', 'Request files').tap()
    const path = await createLink(screen, 'request')
    await browser.clearCookies()
    await app.open(path)
    await verify(screen, 'sender')

    await screen.getByLabel('Choose files').setInputFiles({
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from('Contribution from a verified sender.'),
    })

    await screen.getByRole('status').filter({ hasText: 'Uploaded' }).waitFor()
    await app.screenshot('cloud-request-mobile')
    await expect(
      screen.getByRole('status').filter({ hasText: 'Uploaded' }),
    ).toContainText('Uploaded')
    await expect(screen.getByText(name, { exact: true })).toBeVisible()
    await expect(screen.getByRole('heading', 'Your files')).toHaveCount(0)
    await expect(browser).toHaveURL(path)
  })
})
