import type { SessionData } from '../../utils/session.ts'
import type { AdminDirectoryListing } from '../../models/admin.server.ts'
import type { ShareRecord } from '../../utils/share-store.ts'
import { Layout } from '../Layout.tsx'
import { FlashMessage } from './FlashMessage.tsx'
import { UploadSection } from './UploadSection.tsx'
import { FilesSection } from './FilesSection.tsx'
import { RequestUploadsSection } from './RequestUploadsSection.tsx'
import { ShareListSection } from './ShareListSection.tsx'

type HrefForPath = (targetPath: string, options?: { selection?: string[] }) => string

type AdminDashboardPageProps = {
  user: SessionData
  directory: AdminDirectoryListing
  shares: ShareRecord[]
  message?: string
  error?: string
  highlightToken?: string
  baseUrl: string
  currentPath: string
  selectedEntries: string[]
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
  selectedEntries,
}: AdminDashboardPageProps) {
  let hrefForPath: HrefForPath = (targetPath, options) => {
    let url = new URL(baseUrl)
    if (targetPath) {
      url.searchParams.set('path', targetPath)
    } else {
      url.searchParams.delete('path')
    }
    url.searchParams.delete('message')
    url.searchParams.delete('error')
    url.searchParams.delete('share')
    url.searchParams.delete('selection')

    let selectionValues = options?.selection ?? selectedEntries
    for (let value of selectionValues) {
      url.searchParams.append('selection', value)
    }

    return `${url.pathname}${url.search}#files`
  }

  return (
    <Layout user={user}>
      {message ? <FlashMessage message={message} /> : null}
      {error ? <FlashMessage message={error} /> : null}

      <div className="space-y-8">
        <div className="grid gap-8 lg:grid-cols-2">
          <UploadSection currentPath={currentPath} />
          <RequestUploadsSection currentPath={currentPath} />
        </div>

        <FilesSection
          directory={directory}
          hrefForPath={hrefForPath}
          selectedEntries={selectedEntries}
        />
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
