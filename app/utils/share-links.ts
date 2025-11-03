import { routes } from '../../routes.ts'
import type { DownloadShare, ShareRecord, UploadShare } from './share-store.ts'
import { formatBytes } from './format.ts'

export function buildShareUrl(origin: string, share: ShareRecord) {
  if (share.kind === 'download') {
    return new URL(routes.share.download.href({ token: share.token }), origin).toString()
  }

  return new URL(routes.share.upload.index.href({ token: share.token }), origin).toString()
}

export function summarizeUploadShare(share: UploadShare) {
  if (share.maxBytes == null || share.maxBytes <= 0) {
    return `${formatBytes(share.uploadedBytes)} received (unlimited)`
  }

  let remaining = Math.max(share.maxBytes - share.uploadedBytes, 0)
  return `${formatBytes(share.uploadedBytes)} of ${formatBytes(share.maxBytes)} used - ${formatBytes(remaining)} remaining`
}

export function buildDownloadUrl(base: URL, share: DownloadShare, key: string) {
  let url = new URL(routes.share.download.href({ token: share.token }), base)
  url.searchParams.set('file', key)
  return url.toString()
}
