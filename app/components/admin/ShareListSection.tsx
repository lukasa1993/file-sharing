import { routes } from '../../../routes.ts'
import type { ShareRecord } from '../../utils/share-store.ts'
import { formatDate } from '../../utils/format.ts'
import { buildShareUrl, summarizeUploadShare } from '../../utils/share-links.ts'

type ShareListSectionProps = {
  shares: ShareRecord[]
  highlightToken?: string
  baseUrl: string
}

export function ShareListSection({ shares, highlightToken, baseUrl }: ShareListSectionProps) {
  return (
    <section>
      <h3>Active share links</h3>
      <p>Share tokens expire automatically, or you can revoke them manually.</p>
      {shares.length === 0 ? (
        <p>No active share tokens.</p>
      ) : (
        <ul>
          {shares.map((share) => (
            <li key={share.token}>
              <strong>{share.kind === 'download' ? 'Download share' : 'Upload share'}</strong>
              {highlightToken === share.token ? ' (latest)' : null}
              <div>
                URL: <code>{buildShareUrl(baseUrl, share)}</code>
              </div>
              <div>
                {share.kind === 'download'
                  ? `${share.fileKeys.length} file${share.fileKeys.length === 1 ? '' : 's'}`
                  : summarizeUploadShare(share)}
              </div>
              <div>
                Created {formatDate(share.createdAt.getTime())}
                {share.expiresAt
                  ? ` - Expires ${formatDate(share.expiresAt.getTime())}`
                  : ' - No expiry'}
              </div>
              <form method="POST" action={routes.admin.revokeShare.href()}>
                <input type="hidden" name="token" value={share.token} />
                <button type="submit">Revoke</button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
