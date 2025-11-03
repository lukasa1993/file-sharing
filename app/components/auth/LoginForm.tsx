type LoginFormProps = {
  actionUrl: string
  error?: string
}

export function LoginForm({ actionUrl, error }: LoginFormProps) {
  return (
    <section>
      <h2>Sign in</h2>
      <p>Use the admin credentials configured in your environment variables.</p>
      {error ? <p>{error}</p> : null}
      <form method="POST" action={actionUrl}>
        <p>
          <label>
            Username:
            <input name="username" type="text" required autoComplete="username" />
          </label>
        </p>
        <p>
          <label>
            Password:
            <input name="password" type="password" required autoComplete="current-password" />
          </label>
        </p>
        <button type="submit">Sign in</button>
      </form>
    </section>
  )
}
