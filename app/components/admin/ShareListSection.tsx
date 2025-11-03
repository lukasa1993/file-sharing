import { routes } from '../../../routes.ts'
import type { ShareRecord } from '../../utils/share-store.ts'
import { formatDate } from '../../utils/format.ts'
import { buildShareUrl, summarizeUploadShare } from '../../utils/share-links.ts'
import {
  cardClass,
  dangerButtonClass,
  inlineLinkClass,
  sectionDescriptionClass,
  sectionTitleClass,
} from '../ui.ts'

type ShareListSectionProps = {
  shares: ShareRecord[]
  highlightToken?: string
  baseUrl: string
}

export function ShareListSection({ shares, highlightToken, baseUrl }: ShareListSectionProps) {
  let hasShares = shares.length > 0

  return (
    <section className={`${cardClass} space-y-6`}>
      <header>
        <h3 className={sectionTitleClass}>Active share links</h3>
        <p className={sectionDescriptionClass}>
          Share tokens expire automatically based on your settings, and you can revoke them at any
          moment.
        </p>
      </header>

      {hasShares ? (
        <ul className="space-y-4">
          {shares.map((share) => {
            let isHighlighted = highlightToken === share.token

            return (
              <li
                key={share.token}
                className={`rounded-2xl border px-4 py-5 transition ${
                  isHighlighted
                    ? 'border-sky-500/60 bg-sky-500/10 shadow-lg shadow-sky-500/25'
                    : 'border-slate-800/80 bg-slate-950/50 hover:border-slate-700/70'
                }`}
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider">
                      <span
                        className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
                          share.kind === 'download'
                            ? 'bg-emerald-500/15 text-emerald-200'
                            : 'bg-sky-500/15 text-sky-200'
                        }`}
                      >
                        {share.kind === 'download' ? 'Download share' : 'Upload share'}
                      </span>
                      {isHighlighted ? (
                        <span className="text-xs font-medium text-sky-200">Latest</span>
                      ) : null}
                    </div>
                    <div className="text-sm text-slate-300">
                      <span className="font-medium text-slate-200">URL:</span>{' '}
                      <a
                        href={buildShareUrl(baseUrl, share)}
                        target="_blank"
                        rel="noreferrer"
                        className={inlineLinkClass}
                      >
                        {buildShareUrl(baseUrl, share)}
                      </a>
                    </div>
                    <div className="text-sm text-slate-300">
                      {share.kind === 'download'
                        ? `${share.fileKeys.length} file${
                            share.fileKeys.length === 1 ? '' : 's'
                          }`
                        : summarizeUploadShare(share)}
                    </div>
                    <div className="text-xs uppercase tracking-wide text-slate-500">
                      Created {formatDate(share.createdAt.getTime())}
                      {share.expiresAt
                        ? ` · Expires ${formatDate(share.expiresAt.getTime())}`
                        : ' · No expiry'}
                    </div>
                  </div>
                  <form
                    method="POST"
                    action={routes.admin.revokeShare.href()}
                    className="self-start"
                  >
                    <input type="hidden" name="token" value={share.token} />
                    <button type="submit" className={dangerButtonClass}>
                      Revoke
                    </button>
                  </form>
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed border-slate-800/70 bg-slate-950/40 px-4 py-6 text-sm text-slate-400">
          No active share tokens. Generate a download or upload link to see it appear here.
        </p>
      )}
    </section>
  )
}
