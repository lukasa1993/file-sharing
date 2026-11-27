import { secrets, type TestFixtures } from 'e2e'

export async function createMember(
  screen: TestFixtures['screen'],
  username: string,
) {
  await screen.getByText('Create user', { exact: true, visible: true }).tap()
  const create = screen.getByRole('form', 'Create user', { exact: true })
  await create.getByLabel('Username').fill(username)
  await create
    .getByLabel('Password', { exact: true })
    .fill(secrets.get('memberPassword'))
  await create.getByRole('button', 'Create user').tap()
  await screen.getByRole('row').filter({ hasText: username }).waitFor()
}
