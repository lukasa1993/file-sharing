import type { DownloadShare } from '../../models/share.server.ts'
import { Layout } from '../Layout.tsx'
import { formatBytes, formatDate } from '../../utils/format.ts'
import {
  cardClass,
  primaryButtonClass,
  sectionDescriptionClass,
  sectionTitleClass,
} from '../ui.ts'

type DownloadShareFile = {
  key: string
  name: string
  size: number
  type?: string
  downloadUrl: string
  lastModified: number
}

type DownloadSharePageProps = {
  token: string
  share: DownloadShare
  files: DownloadShareFile[]
}

export function DownloadSharePage({ token, share, files }: DownloadSharePageProps) {
  let listCardClass =
    'rounded-2xl border border-slate-800/80 bg-slate-950/60 p-5 shadow-lg shadow-slate-950/40 transition hover:border-slate-700/70'

  return (
    <Layout variant="minimal">
      <section className={`${cardClass} mx-auto w-full max-w-3xl space-y-6`}>
        <header className="space-y-3">
          <h2 className={`${sectionTitleClass} text-2xl`}>Files ready for download</h2>
          <p className={sectionDescriptionClass}>
            These files were securely shared by an administrator. Download them before the link
            expires or is revoked.
          </p>
          <div className="rounded-xl border border-slate-800/80 bg-slate-950/60 px-4 py-3 text-xs uppercase tracking-wide text-slate-400">
            Token <span className="text-slate-200">{token}</span>
            {share.expiresAt
              ? ` · Expires ${formatDate(share.expiresAt.getTime())}`
              : ' · No expiry set'}
          </div>
        </header>
        <ul className="grid gap-4 md:grid-cols-2">
          {files.map((file) => (
            <li key={file.key} className={listCardClass}>
              <div className="space-y-3">
                <div>
                  <h3 className="text-lg font-semibold text-white">{file.name}</h3>
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    {file.type || 'Binary'}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs text-slate-400">
                  <span className="font-medium text-slate-300">Size</span>
                  <span>{formatBytes(file.size)}</span>
                  <span className="font-medium text-slate-300">Updated</span>
                  <span>{formatDate(file.lastModified)}</span>
                </div>
                <div className="rounded-lg border border-slate-800/80 bg-slate-950/60 px-3 py-2 text-xs text-slate-400">
                  Key:{' '}
                  <code className="break-all text-slate-300">{file.key}</code>
                </div>
                <a
                  href={file.downloadUrl}
                  download={file.name}
                  className={`${primaryButtonClass} inline-flex w-full justify-center`}
                >
                  Download
                </a>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </Layout>
  )
}
