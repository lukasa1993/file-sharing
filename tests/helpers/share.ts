import type { TestFixtures } from 'e2e'

type Screen = TestFixtures['screen']

export async function folder(screen: Screen, name: string) {
  await screen.getByRole('button', 'New folder').tap()
  const form = screen.getByRole('dialog', 'New folder')
  await form.getByLabel('Name', { exact: true }).fill(name)
  await form.getByRole('button', 'Create folder').tap()
  await screen
    .getByRole('button', 'Actions for ' + name, { exact: true })
    .waitFor()
}
export async function shareItem(screen: Screen, name: string, upload = false) {
  await screen.getByRole('button', 'Actions for ' + name, { exact: true }).tap()
  await screen
    .getByRole('button', upload ? 'Request uploads' : 'Create share link', {
      exact: true,
    })
    .tap()
}
