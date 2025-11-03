import type { UploadShare } from '../../models/share.server.ts'
import { Layout } from '../Layout.tsx'
import { summarizeUploadShare } from '../../utils/share-links.ts'
import { formatDate } from '../../utils/format.ts'

type UploadSharePageProps = {
  token: string
  share: UploadShare
  actionUrl: string
  message?: string | null
  error?: string | null
}

export function UploadSharePage({ token, share, actionUrl, message, error }: UploadSharePageProps) {
  return (
    <Layout>
      <section>
        <h2>Send files to the admin</h2>
        <p>This link lets you deliver files directly to the administrator.</p>
        <p>
          Token: <code>{token}</code>
          {share.expiresAt ? ` - Expires ${formatDate(share.expiresAt.getTime())}` : ' - No expiry'}
          {' - '}
          {summarizeUploadShare(share)}
        </p>
        {message ? <p>{message}</p> : null}
        {error ? <p>{error}</p> : null}
        <form method="POST" action={actionUrl} encType="multipart/form-data">
          <p>
            <label>
              Files:
              <input type="file" name="files" multiple required />
            </label>
          </p>
          <button type="submit">Send files</button>
        </form>
      </section>
    </Layout>
  )
}
