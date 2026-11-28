import { credentials, type TestFixtures } from 'e2e'

export async function signInOwner(
  app: TestFixtures['app'],
  screen: TestFixtures['screen'],
) {
  const owner = credentials.user('owner')
  await app.open('/login')
  await screen.getByLabel('Username').fill(owner.username)
  await screen.getByLabel('Password', { exact: true }).fill(owner.password)
  await screen.getByRole('button', 'Sign in').tap()
  await screen.getByRole('button', 'Display preferences').waitFor()
}
