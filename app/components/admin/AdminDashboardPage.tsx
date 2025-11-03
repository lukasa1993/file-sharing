import type { SessionData } from '../../utils/session.ts'
import type { AdminFile } from '../../models/admin.server.ts'
import type { ShareRecord } from '../../utils/share-store.ts'
import { Layout } from '../Layout.tsx'
import { FlashMessage } from './FlashMessage.tsx'
import { UploadSection } from './UploadSection.tsx'
import { FilesSection } from './FilesSection.tsx'
import { RequestUploadsSection } from './RequestUploadsSection.tsx'
import { ShareListSection } from './ShareListSection.tsx'

type AdminDashboardPageProps = {
  user: SessionData
  files: AdminFile[]
  shares: ShareRecord[]
  message?: string
  error?: string
  highlightToken?: string
  baseUrl: string
}

export function AdminDashboardPage({
  user,
  files,
  shares,
  message,
  error,
  highlightToken,
  baseUrl,
}: AdminDashboardPageProps) {
  return (
    <Layout user={user}>
      <h2>Admin Console</h2>
      <p>Upload files, create download shares, or request uploads from collaborators.</p>

      {message ? <FlashMessage message={message} /> : null}
      {error ? <FlashMessage message={error} /> : null}

      <UploadSection />
      <FilesSection files={files} />
      <RequestUploadsSection />
      <ShareListSection shares={shares} highlightToken={highlightToken} baseUrl={baseUrl} />
    </Layout>
  )
}
