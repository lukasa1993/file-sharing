import { Layout } from '../Layout.tsx'
import { cardClass, sectionDescriptionClass, sectionTitleClass } from '../ui.ts'

type ShareUnavailableProps = {
  message: string
}

export function ShareUnavailable({ message }: ShareUnavailableProps) {
  return (
    <Layout variant="minimal">
      <section className={`${cardClass} mx-auto w-full max-w-xl space-y-4 text-center`}>
        <h2 className={`${sectionTitleClass} text-2xl`}>Share unavailable</h2>
        <p className={sectionDescriptionClass}>{message}</p>
        <p className="text-xs uppercase tracking-wide text-slate-500">
          Confirm with the administrator or request a new link.
        </p>
      </section>
    </Layout>
  )
}
