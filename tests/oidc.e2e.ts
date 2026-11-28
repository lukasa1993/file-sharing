import { describe, test } from '@e2e-dev/web'
import { expect } from 'e2e'
import { signInOwner } from './helpers/owner.ts'

const fixtureTest = test.runIf(process.env.E2E_FIXTURE_OIDC === '1')

describe('external identity', () => {
  test('a local account can sign in using the configured password', async ({
    app,
    screen,
  }) => {
    if (process.env.E2E_FIXTURE_OIDC === '0') {
      await app.open('/login')
      await expect(
        screen.getByRole('button', 'Continue with identity provider'),
      ).toHaveCount(0)
    }
    await signInOwner(app, screen)
    await app.open('/_/account')
    await expect(
      screen
        .getByRole('region', 'Profile')
        .getByText('e2e-owner', { exact: true }),
    ).toBeVisible()
  })

  fixtureTest(
    'an explicitly mapped identity starts a local session and returns to the requested page',
    async ({ app, screen, browser }) => {
      await app.open('/login?next=%2F_%2Faccount')
      await screen.getByRole('button', 'Continue with identity provider').tap()
      await screen.getByRole('heading', 'Choose a test account').waitFor()

      await screen.getByRole('button', 'Mapped account', { exact: true }).tap()

      await expect(browser).toHaveURL('/_/account')
      await expect(
        screen
          .getByRole('region', 'Profile')
          .getByText('e2e-owner', { exact: true }),
      ).toBeVisible()
    },
  )

  fixtureTest(
    'an unmapped subject returns to the local sign-in form',
    async ({ app, screen }) => {
      await app.open('/login')
      await screen.getByRole('button', 'Continue with identity provider').tap()
      await screen.getByRole('heading', 'Choose a test account').waitFor()

      await screen
        .getByRole('button', 'Unmapped account', { exact: true })
        .tap()

      await expect(screen.getByRole('alert')).toContainText(
        'Could not sign in with the identity provider',
      )
      await expect(
        screen.getByRole('button', 'Sign in', { exact: true }),
      ).toBeVisible()
    },
  )
})
