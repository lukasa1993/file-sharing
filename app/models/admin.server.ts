import {
  createStoredDirectory,
  deleteStoredDirectory,
  deleteStoredFile,
  listDirectoryEntries,
  listStoredFiles,
  moveStoredEntries,
  type MoveStoredEntriesResult,
  publicPathForKey,
  saveFile,
} from '../utils/uploads.ts'
import {
  createDownloadShareLink as createDownloadShareLinkInternal,
  createUploadShareLink as createUploadShareLinkInternal,
  listShareRecords,
  registerUploadForToken as registerUploadForTokenInternal,
  revokeShareToken as revokeShareTokenInternal,
  type ShareRecord,
} from './share.server.ts'
import { removeFileFromShares, replaceFileKeys } from '../utils/share-store.ts'

export type AdminDirectoryListing = Awaited<ReturnType<typeof listDirectoryEntries>>

export type DashboardData = {
  directory: AdminDirectoryListing
  shares: ShareRecord[]
}

export async function getDashboardData(path?: string): Promise<DashboardData> {
  let [directory, shares] = await Promise.all([
    listDirectoryEntries(path),
    listShareRecords(),
  ])
  return {
    directory,
    shares,
  }
}

export async function storeUploadedFiles(files: File[], options?: { directory?: string }) {
  let prefix = options?.directory
  await Promise.all(files.map((file) => saveFile(file, { prefix })))
}

export async function deleteFileAndShares(key: string) {
  await deleteStoredFile(key)
  await removeFileFromShares(key)
}

export async function deleteDirectoryAndShares(path: string) {
  let files = await listStoredFiles({ path, recursive: true })
  await deleteStoredDirectory(path)
  await Promise.all(files.map((file) => removeFileFromShares(file.key)))
}

export async function createDirectory(path: string) {
  await createStoredDirectory(path)
}

export async function moveEntriesToDirectory(
  entries: string[],
  destination: string,
): Promise<MoveStoredEntriesResult> {
  let result = await moveStoredEntries(entries, destination)
  if (result.files.length > 0) {
    await replaceFileKeys(result.files)
  }
  return result
}

export async function createDownloadShareLink(
  keys: string[],
  options?: { expiresInMinutes?: number },
) {
  return createDownloadShareLinkInternal(keys, options)
}

export async function createUploadShareLink(options?: {
  expiresInMinutes?: number
  maxBytes?: number
  targetDirectory?: string
}) {
  return createUploadShareLinkInternal(options)
}

export async function revokeShareToken(token: string) {
  await revokeShareTokenInternal(token)
}

export async function registerUploadForToken(token: string, bytes: number) {
  await registerUploadForTokenInternal(token, bytes)
}

export function getPublicFileUrl(key: string) {
  return publicPathForKey(key)
}

export async function collectDownloadShareKeys(fileKeys: string[], directoryKeys: string[]) {
  let keys = new Set<string>()
  for (let key of fileKeys) {
    if (typeof key === 'string' && key.trim().length > 0) {
      keys.add(key)
    }
  }

  for (let directory of directoryKeys) {
    if (typeof directory !== 'string' || directory.trim().length === 0) {
      continue
    }

    let files = await listStoredFiles({ path: directory, recursive: true })
    if (files.length === 0) {
      continue
    }

    for (let file of files) {
      keys.add(file.key)
    }
  }

  if (keys.size === 0) {
    throw new Error('The selected folders do not contain any files to share yet.')
  }

  return Array.from(keys)
}
