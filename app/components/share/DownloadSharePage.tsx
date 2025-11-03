import type { DownloadShare } from '../../models/share.server.ts'
import { Layout } from '../Layout.tsx'
import { formatBytes, formatDate } from '../../utils/format.ts'

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
  return (
    <Layout>
      <section>
        <h2>Files ready for download</h2>
        <p>These files were shared by an administrator. Links may expire without notice.</p>
        <p>
          Token: <code>{token}</code>
          {share.expiresAt ? ` - Expires ${formatDate(share.expiresAt.getTime())}` : ' - No expiry'}
        </p>
        <ul>
          {files.map((file) => (
            <li key={file.key}>
              <strong>{file.name}</strong>
              <div>Type: {file.type || 'binary'}</div>
              <div>Size: {formatBytes(file.size)}</div>
              <div>
                Key: <code>{file.key}</code>
              </div>
              <p>
                <a href={file.downloadUrl} download={file.name}>
                  Download
                </a>
              </p>
            </li>
          ))}
        </ul>
      </section>
    </Layout>
  )
}
