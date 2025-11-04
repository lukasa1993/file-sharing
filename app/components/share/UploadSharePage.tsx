import type { UploadShare } from '../../models/share.server.ts'
import { Layout } from '../Layout.tsx'
import { summarizeUploadShare } from '../../utils/share-links.ts'
import { formatDate } from '../../utils/format.ts'
import {
  cardClass,
  fileInputClass,
  primaryButtonClass,
  sectionDescriptionClass,
  sectionTitleClass,
} from '../ui.ts'

type UploadSharePageProps = {
  share: UploadShare
  actionUrl: string
  message?: string | null
  error?: string | null
}

export function UploadSharePage({ share, actionUrl, message, error }: UploadSharePageProps) {
  let alertBaseClass =
    'rounded-xl border px-4 py-3 text-sm font-medium shadow-inner backdrop-blur transition'
  let successClass = `${alertBaseClass} border-emerald-500/40 bg-emerald-500/10 text-emerald-100 shadow-emerald-500/20`
  let errorClass = `${alertBaseClass} border-rose-500/40 bg-rose-500/10 text-rose-100 shadow-rose-500/25`

  return (
    <Layout variant="minimal">
      <section className={`${cardClass} mx-auto w-full max-w-2xl space-y-6`}>
        <header className="space-y-3">
          <h2 className={`${sectionTitleClass} text-2xl`}>Send files securely</h2>
          <p className={sectionDescriptionClass}>
            This upload link delivers files directly to the administrator without exposing your
            storage. Uploaded items appear instantly in the admin console.
          </p>
          <div className="rounded-xl border border-slate-800/80 bg-slate-950/60 px-4 py-3 text-xs uppercase tracking-wide text-slate-400">
            <div className="flex flex-col gap-1">
              <span className="text-slate-200">
                {share.expiresAt
                  ? `Link expires ${formatDate(share.expiresAt.getTime())}`
                  : 'No expiry set for this link'}
              </span>
              <span>{summarizeUploadShare(share)}</span>
            </div>
          </div>
        </header>
        {message ? (
          <p data-flash-message role="status" className={successClass}>
            {message}
          </p>
        ) : null}
        {error ? (
          <p data-flash-message role="status" className={errorClass}>
            {error}
          </p>
        ) : null}
        <form method="POST" action={actionUrl} encType="multipart/form-data" className="space-y-4">
          <div className="space-y-3 sm:space-y-0 sm:flex sm:gap-3">
            <label className="block text-sm font-medium text-slate-200 sm:flex-1">
              Select files
              <input type="file" name="files" multiple className={fileInputClass} />
            </label>
            <label className="block text-sm font-medium text-slate-200 sm:flex-1">
              Or upload a folder
              <input
                type="file"
                name="files"
                multiple
                webkitdirectory="true"
                directory="true"
                className={fileInputClass}
              />
            </label>
          </div>
          <p className="text-xs text-slate-400">
            Mix files and folders freely. Hidden system files are ignored automatically.
          </p>
          <button type="submit" className={`${primaryButtonClass} w-full`}>
            Send items
          </button>
        </form>
      </section>
    </Layout>
  )
}
