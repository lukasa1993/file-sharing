/** @jsxImportSource remix/component */
import { clientEntry, on, type Handle } from 'remix/component'

export const PasswordField = clientEntry(
  '/assets/login-client.js#PasswordField',
  function PasswordField(handle: Handle) {
    let visible = false
    return () => (
      <div class="password-field">
        <label for="login-password">Password</label>
        <div class="password-wrap">
          {visible ? (
            <input
              id="login-password"
              name="password"
              type="text"
              required
              autocomplete="current-password"
            />
          ) : (
            <input
              id="login-password"
              name="password"
              type="password"
              required
              autocomplete="current-password"
            />
          )}
          <button
            type="button"
            aria-label={visible ? 'Hide password' : 'Show password'}
            aria-pressed={visible}
            aria-controls="login-password"
            mix={on('click', async () => {
              visible = !visible
              await handle.update()
            })}
          >
            {visible ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
    )
  },
)
