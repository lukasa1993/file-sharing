import { LocalFileStorage } from '@remix-run/file-storage/local'
import type { FileUploadHandler } from '@remix-run/form-data-parser'

import { config } from '../config.ts'

export type StoredFile = {
  key: string
  name: string
  type: string
  size: number
  lastModified: number
}

export const uploadsStorage = new LocalFileStorage(config.storageRoot)

export const uploadHandler: FileUploadHandler = async (file) => file

export async function saveFile(file: File, options?: { prefix?: string; key?: string }) {
  if (!(file instanceof File)) {
    throw new TypeError('Expected a File instance')
  }

  let prefix = options?.prefix ?? 'files'
  let extension = extractExtension(file.name)
  let key =
    options?.key ?? `${prefix}/${Date.now()}-${randomId()}${extension ? `.${extension}` : ''}`

  await uploadsStorage.set(key, file)

  return {
    key,
    path: publicPathForKey(key),
  }
}

export async function getStoredFile(key: string) {
  return uploadsStorage.get(key)
}

export async function deleteStoredFile(key: string) {
  await uploadsStorage.remove(key)
}

export async function listStoredFiles(): Promise<StoredFile[]> {
  let cursor: string | undefined
  let files: StoredFile[] = []

  do {
    let result = await uploadsStorage.list({ cursor, includeMetadata: true, limit: 64 })
    let page = (result.files as StoredFile[]) ?? []
    files.push(...page)
    cursor = result.cursor
  } while (cursor)

  return files.sort((a, b) => b.lastModified - a.lastModified)
}

export function publicPathForKey(key: string) {
  return `/uploads/${key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`
}

function extractExtension(filename: string) {
  let parts = filename.split('.')
  if (parts.length <= 1) return ''
  return parts.pop() ?? ''
}

function randomId() {
  let cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID().replace(/-/g, '').slice(0, 8)
  }

  return Math.random().toString(36).slice(2, 10)
}
