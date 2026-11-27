import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
import { signInOwner } from './helpers/owner.ts'

test.setup(
  'sign in to the disposable workspace',
  { sessions: ['owner'] },
  async ({ app, screen, session }) => {
    await signInOwner(app, screen)
    await expect(
      screen.getByRole('button', 'Display preferences'),
    ).toBeVisible()
    await session.save('owner')
  },
)
