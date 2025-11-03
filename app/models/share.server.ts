import {
  createDownloadShare,
  createUploadShare,
  getShare,
  listShares,
  registerUpload,
  removeShare,
  type ShareRecord,
  type DownloadShare,
  type UploadShare,
} from '../utils/share-store.ts'

export type { ShareRecord, DownloadShare, UploadShare }

export async function listShareRecords() {
  return listShares()
}

export async function createDownloadShareLink(
  keys: string[],
  options?: { expiresInMinutes?: number },
) {
  return createDownloadShare(keys, options)
}

export async function createUploadShareLink(options?: {
  expiresInMinutes?: number
  maxBytes?: number
}) {
  return createUploadShare(options)
}

export async function revokeShareToken(token: string) {
  await removeShare(token)
}

export async function registerUploadForToken(token: string, bytes: number) {
  await registerUpload(token, bytes)
}

export function findShare(token: string) {
  return getShare(token)
}
