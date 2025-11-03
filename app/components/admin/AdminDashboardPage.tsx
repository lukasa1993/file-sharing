import type { SessionData } from '../../utils/session.ts'
import type { AdminDirectoryListing } from '../../models/admin.server.ts'
import type { ShareRecord } from '../../utils/share-store.ts'
import { Layout } from '../Layout.tsx'
import { FlashMessage } from './FlashMessage.tsx'
import { UploadSection } from './UploadSection.tsx'
import { FilesSection } from './FilesSection.tsx'
import { RequestUploadsSection } from './RequestUploadsSection.tsx'
import { ShareListSection } from './ShareListSection.tsx'

type AdminDashboardPageProps = {
  user: SessionData
  directory: AdminDirectoryListing
  shares: ShareRecord[]
  message?: string
  error?: string
  highlightToken?: string
  baseUrl: string
  currentPath: string
}

export function AdminDashboardPage({
  user,
  directory,
  shares,
  message,
  error,
  highlightToken,
  currentPath,
  baseUrl,
}: AdminDashboardPageProps) {
  let hrefForPath = (targetPath: string) => {
    let url = new URL(baseUrl)
    if (targetPath) {
      url.searchParams.set('path', targetPath)
    } else {
      url.searchParams.delete('path')
    }
    url.searchParams.delete('message')
    url.searchParams.delete('error')
    url.searchParams.delete('share')
    return `${url.pathname}${url.search}`
  }

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

      <div className="space-y-8">
        <div className="grid gap-8 lg:grid-cols-2">
          <UploadSection currentPath={currentPath} />
          <RequestUploadsSection currentPath={currentPath} />
        </div>

        <FilesSection directory={directory} hrefForPath={hrefForPath} />
      </div>

      <ShareListSection
        shares={shares}
        highlightToken={highlightToken}
        baseUrl={baseUrl}
        currentPath={currentPath}
      />
    </Layout>
  )
}
