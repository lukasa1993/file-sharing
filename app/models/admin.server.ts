import { deleteStoredFile, listStoredFiles, publicPathForKey, saveFile } from '../utils/uploads.ts'
import {
  createDownloadShareLink as createDownloadShareLinkInternal,
  createUploadShareLink as createUploadShareLinkInternal,
  listShareRecords,
  registerUploadForToken as registerUploadForTokenInternal,
  revokeShareToken as revokeShareTokenInternal,
  type ShareRecord,
} from './share.server.ts'
import { removeFileFromShares } from '../utils/share-store.ts'

export type AdminFile = Awaited<ReturnType<typeof listStoredFiles>>[number]

export type DashboardData = {
  files: AdminFile[]
  shares: ShareRecord[]
}

export async function getDashboardData(): Promise<DashboardData> {
  let [files, shares] = await Promise.all([listStoredFiles(), listShareRecords()])
  return {
    files,
    shares,
  }
}

export async function storeUploadedFiles(files: File[]) {
  await Promise.all(files.map((file) => saveFile(file)))
}

export async function deleteFileAndShares(key: string) {
  await deleteStoredFile(key)
  await removeFileFromShares(key)
}

export async function createDownloadShareLink(
  keys: string[],
  options?: { expiresInMinutes?: number },
) {
  return createDownloadShareLinkInternal(keys, options)
}

export async function createUploadShareLink(options?: {
  expiresInMinutes?: number
  maxFiles?: number
}) {
  return createUploadShareLinkInternal(options)
}

export async function revokeShareToken(token: string) {
  await revokeShareTokenInternal(token)
}

export async function registerUploadForToken(token: string, count: number) {
  await registerUploadForTokenInternal(token, count)
}

export function getPublicFileUrl(key: string) {
  return publicPathForKey(key)
}
