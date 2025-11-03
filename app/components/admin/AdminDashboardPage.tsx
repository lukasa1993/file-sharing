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
      <header className="space-y-3">
        <h2 className="text-3xl font-semibold tracking-tight text-white">Admin Console</h2>
        <p className="max-w-2xl text-base leading-relaxed text-slate-300">
          Upload assets, curate secure download links, or invite collaborators to send files without
          granting full access.
        </p>
      </header>

      <div className="space-y-3">
        {message ? <FlashMessage message={message} /> : null}
        {error ? <FlashMessage message={error} /> : null}
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <UploadSection />
        <RequestUploadsSection />
      </div>

      <FilesSection files={files} />

      <ShareListSection shares={shares} highlightToken={highlightToken} baseUrl={baseUrl} />
    </Layout>
  )
}
