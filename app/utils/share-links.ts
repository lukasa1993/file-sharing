import { routes } from '../../routes.ts'
import type { DownloadShare, ShareRecord, UploadShare } from './share-store.ts'

export function buildShareUrl(origin: string, share: ShareRecord) {
  if (share.kind === 'download') {
    return new URL(routes.share.download.href({ token: share.token }), origin).toString()
  }

  return new URL(routes.share.upload.index.href({ token: share.token }), origin).toString()
}

export function summarizeUploadShare(share: UploadShare) {
  if (share.maxFiles == null) {
    let uploads = share.uploadedCount
    return `${uploads} upload${uploads === 1 ? '' : 's'} so far`
  }

  let remaining = Math.max(share.maxFiles - share.uploadedCount, 0)
  return `${share.uploadedCount}/${share.maxFiles} uploads used - ${remaining} remaining`
}

export function buildDownloadUrl(base: URL, share: DownloadShare, key: string) {
  let url = new URL(routes.share.download.href({ token: share.token }), base)
  url.searchParams.set('file', key)
  return url.toString()
}
