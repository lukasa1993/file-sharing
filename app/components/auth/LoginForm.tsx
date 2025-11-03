import {
  cardClass,
  inputClass,
  primaryButtonClass,
  sectionDescriptionClass,
  sectionTitleClass,
} from '../ui.ts'

type LoginFormProps = {
  actionUrl: string
  error?: string
}

export function LoginForm({ actionUrl, error }: LoginFormProps) {
  return (
    <section className={`${cardClass} mx-auto w-full max-w-md space-y-6`}>
      <header>
        <h2 className={`${sectionTitleClass} text-2xl`}>Sign in</h2>
        <p className={sectionDescriptionClass}>
          Use the admin credentials configured in your environment variables to access the console.
        </p>
      </header>
      {error ? (
        <p className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm font-medium text-rose-100">
          {error}
        </p>
      ) : null}
      <form method="POST" action={actionUrl} className="space-y-4">
        <label className="block text-sm font-medium text-slate-200">
          Username
          <input name="username" type="text" required autoComplete="username" className={inputClass} />
        </label>
        <label className="block text-sm font-medium text-slate-200">
          Password
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className={inputClass}
          />
        </label>
        <button type="submit" className={`${primaryButtonClass} w-full justify-center`}>
          Sign in
        </button>
      </form>
    </section>
  )
}
