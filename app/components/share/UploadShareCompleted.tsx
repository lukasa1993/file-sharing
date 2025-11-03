import { Layout } from '../Layout.tsx'
import { cardClass, sectionDescriptionClass, sectionTitleClass } from '../ui.ts'

type UploadShareCompletedProps = {
  message: string
}

export function UploadShareCompleted({ message }: UploadShareCompletedProps) {
  return (
    <Layout variant="minimal">
      <section className={`${cardClass} mx-auto w-full max-w-xl space-y-4 text-center`}>
        <h2 className={`${sectionTitleClass} text-2xl`}>Uploads received</h2>
        <p className={sectionDescriptionClass}>{message}</p>
        <p className="text-xs uppercase tracking-wide text-slate-500">
          You can close this window once the administrator confirms receipt.
        </p>
      </section>
    </Layout>
  )
}
