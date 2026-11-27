import { run } from 'remix/component'
import { PasswordField } from './login-client'

run({
  async loadModule(href, name) {
    if (
      new URL(href, location.href).href !==
        new URL('/assets/login-client.js', location.origin).href ||
      name !== 'PasswordField'
    ) {
      throw new Error('Unknown login component')
    }
    return PasswordField
  },
})
