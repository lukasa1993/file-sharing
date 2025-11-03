import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

import { config } from '../config.ts'

export type DownloadShare = {
  token: string
  kind: 'download'
  fileKeys: string[]
  createdAt: Date
  expiresAt?: Date
}

export type UploadShare = {
  token: string
  kind: 'upload'
  createdAt: Date
  expiresAt?: Date
  maxFiles?: number
  uploadedCount: number
}

export type ShareRecord = DownloadShare | UploadShare

type PersistedShare = {
  token: string
  kind: ShareRecord['kind']
  createdAt: string
  expiresAt?: string | null
  fileKeys?: string[]
  maxFiles?: number
  uploadedCount?: number
}

const shareStorePath = config.shareStoreFile
mkdirSync(dirname(shareStorePath), { recursive: true })

let shares = new Map<string, ShareRecord>()

await loadSharesFromDisk()

export async function createDownloadShare(
  fileKeys: string[],
  options?: { expiresInMinutes?: number },
) {
  if (fileKeys.length === 0) {
    throw new Error('At least one file key is required to create a download share')
  }

  let token = randomToken()
  let record: DownloadShare = {
    token,
    kind: 'download',
    fileKeys: [...new Set(fileKeys)],
    createdAt: new Date(),
    expiresAt: resolveExpiry(options?.expiresInMinutes),
  }

  shares.set(token, record)
  await persistShares()
  return record
}

export async function createUploadShare(options?: {
  expiresInMinutes?: number
  maxFiles?: number
}) {
  let token = randomToken()
  let record: UploadShare = {
    token,
    kind: 'upload',
    createdAt: new Date(),
    expiresAt: resolveExpiry(options?.expiresInMinutes),
    maxFiles: options?.maxFiles,
    uploadedCount: 0,
  }

  shares.set(token, record)
  await persistShares()
  return record
}

export function getShare(token: string) {
  let record = shares.get(token)
  if (!record) return null

  if (isExpired(record)) {
    shares.delete(token)
    void persistShares()
    return null
  }

  return record
}

export async function listShares(): Promise<ShareRecord[]> {
  let changed = false
  for (let [token, record] of shares) {
    if (isExpired(record)) {
      shares.delete(token)
      changed = true
    }
  }

  if (changed) {
    await persistShares()
  }

  return Array.from(shares.values()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

export async function removeShare(token: string) {
  if (shares.delete(token)) {
    await persistShares()
  }
}

export async function removeFileFromShares(fileKey: string) {
  let changed = false
  for (let [token, record] of shares) {
    if (record.kind === 'download') {
      let filtered = record.fileKeys.filter((key) => key !== fileKey)
      if (filtered.length !== record.fileKeys.length) {
        changed = true
        if (filtered.length === 0) {
          shares.delete(token)
        } else {
          record.fileKeys = filtered
          shares.set(token, record)
        }
      }
    }
  }

  if (changed) {
    await persistShares()
  }
}

export async function registerUpload(token: string, count = 1) {
  let record = shares.get(token)
  if (!record || record.kind !== 'upload') {
    throw new Error('Upload share not found')
  }

  record.uploadedCount += count

  if (record.maxFiles != null && record.uploadedCount >= record.maxFiles) {
    shares.delete(token)
  } else {
    shares.set(token, record)
  }

  await persistShares()
}

async function loadSharesFromDisk() {
  try {
    let file = Bun.file(shareStorePath)
    if (!(await file.exists())) {
      return
    }

    let text = await file.text()
    if (!text) {
      return
    }

    let records = JSON.parse(text) as PersistedShare[]
    for (let record of records) {
      if (record.kind === 'download' && record.fileKeys) {
        shares.set(record.token, {
          token: record.token,
          kind: 'download',
          fileKeys: record.fileKeys,
          createdAt: new Date(record.createdAt),
          expiresAt: record.expiresAt ? new Date(record.expiresAt) : undefined,
        })
      } else if (record.kind === 'upload') {
        shares.set(record.token, {
          token: record.token,
          kind: 'upload',
          createdAt: new Date(record.createdAt),
          expiresAt: record.expiresAt ? new Date(record.expiresAt) : undefined,
          maxFiles: record.maxFiles,
          uploadedCount: record.uploadedCount ?? 0,
        })
      }
    }
  } catch (error) {
    console.error('Failed to load share store', error)
  }
}

async function persistShares() {
  let serializable: PersistedShare[] = []
  for (let record of shares.values()) {
    if (record.kind === 'download') {
      serializable.push({
        token: record.token,
        kind: 'download',
        createdAt: record.createdAt.toISOString(),
        expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
        fileKeys: record.fileKeys,
      })
    } else {
      serializable.push({
        token: record.token,
        kind: 'upload',
        createdAt: record.createdAt.toISOString(),
        expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
        maxFiles: record.maxFiles,
        uploadedCount: record.uploadedCount,
      })
    }
  }

  await Bun.write(shareStorePath, JSON.stringify(serializable, null, 2))
}

function resolveExpiry(expiresInMinutes?: number) {
  if (expiresInMinutes == null || Number.isNaN(expiresInMinutes) || expiresInMinutes <= 0) {
    return undefined
  }

  return new Date(Date.now() + expiresInMinutes * 60_000)
}

function isExpired(record: ShareRecord) {
  return record.expiresAt != null && record.expiresAt.getTime() <= Date.now()
}

function randomToken() {
  return randomBytes(24).toString('base64url')
}
