import { describe, test } from '@e2e-dev/web'
import { expect } from 'e2e'

describe('cross-storage file management', { session: 'owner' }, () => {
  test('cancels an active move and keeps the original file in its folder', async ({
    app,
    screen,
  }) => {
    await app.open('/_/files?mount=deliveries&path=Operation%20examples')
    await screen.getByRole('button', 'Actions for Move sample.bin').tap()
    await screen
      .getByRole('dialog', 'File actions')
      .getByRole('button', 'Move to')
      .tap()
    const operation = screen.getByRole('dialog', 'Move items')
    await operation
      .getByLabel('Destination storage')
      .selectOption({ label: 'Files' })
    await operation.getByLabel('Destination folder').fill('')
    await operation.getByRole('button', 'Move', { exact: true }).tap()
    await operation.getByText(/Copying Move sample\.bin/).waitFor()
    await expect(
      operation.getByRole('progressbar', 'File operation progress'),
    ).toBeVisible()

    await operation.getByRole('button', 'Cancel operation').tap()
    await operation
      .getByRole('alert')
      .getByText(/cancelled before publication/i)
      .waitFor()
    await operation.getByRole('button', 'Cancel', { exact: true }).tap()
    await screen.getByRole('button', 'Refresh files').tap()
    await expect(
      screen.getByRole('link', 'Move sample.bin', { exact: true }),
    ).toBeVisible()
    await app.open('/_/files?mount=e2e')
    await expect(
      screen.getByRole('link', 'Move sample.bin', { exact: true }),
    ).toHaveCount(0)
  })
})
