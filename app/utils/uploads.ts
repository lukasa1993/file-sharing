import { mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join, posix, resolve, sep } from 'node:path'
import type { Dirent } from 'node:fs'

import type { FileUploadHandler } from '@remix-run/form-data-parser'

import { config } from '../config.ts'

export type StoredFile = {
  key: string
  name: string
  type: string
  size: number
  lastModified: number
}

export type StoredDirectory = {
  key: string
  name: string
  lastModified: number
}

export type DirectoryListing = {
  path: string
  directories: StoredDirectory[]
  files: StoredFile[]
}

export type DirectoryTreeNode = {
  key: string
  name: string
  children: DirectoryTreeNode[]
}

export type MovedEntry = {
  from: string
  to: string
  kind: 'file' | 'directory'
}

export type FileReplacement = {
  from: string
  to: string
}

export type MoveStoredEntriesResult = {
  entries: MovedEntry[]
  files: FileReplacement[]
}

const storageRoot = resolve(config.storageRoot)
const storageRootWithSep = storageRoot.endsWith(sep) ? storageRoot : `${storageRoot}${sep}`

const junkExactNames = new Set([
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  '.temporaryitems',
  '.trashes',
  '.spotlight-v100',
  '.fseventsd',
  '.localized',
  '__macosx',
])

const junkPrefixPatterns = ['._']

export const uploadHandler: FileUploadHandler = async (file) => file

export async function saveFile(
  file: File,
  options?: { prefix?: string; key?: string },
): Promise<{ key: string; path: string } | null> {
  if (!(file instanceof File)) {
    throw new TypeError('Expected a File instance')
  }

  let prefix = normalizeOptionalRelativePath(options?.prefix)
  let providedKey = options?.key ? normalizeRequiredPath(options.key) : undefined

  let relativeFromFile = extractRelativePath(file)
  let { path: relativePath, isDirectory } = parseRelativeUploadPath(relativeFromFile)

  if (isIgnoredUpload(file, relativePath)) {
    return null
  }

  if (isDirectory) {
    let directoryKey =
      providedKey ??
      (relativePath ? joinNormalized(prefix, relativePath) : prefix ? prefix : undefined)
    if (!directoryKey) {
      return null
    }

    let directoryPath = resolveStoragePath(directoryKey)
    await mkdir(directoryPath, { recursive: true })
    return null
  }

  let targetKey =
    providedKey ??
    (relativePath ? joinNormalized(prefix, relativePath) : buildInitialKey(prefix, file.name))

  if (!providedKey) {
    targetKey = await ensureUniqueKey(targetKey)
  }

  let fullPath = resolveStoragePath(targetKey)
  await mkdir(dirname(fullPath), { recursive: true })
  await Bun.write(fullPath, file)

  return {
    key: targetKey,
    path: publicPathForKey(targetKey),
  }
}

export function isDirectoryUpload(file: File) {
  let relativeFromFile = extractRelativePath(file)
  if (!relativeFromFile) {
    return false
  }

  return parseRelativeUploadPath(relativeFromFile).isDirectory
}

export async function getStoredFile(key: string) {
  let normalizedKey = normalizeRequiredPath(key)
  let fullPath = resolveStoragePath(normalizedKey)

  let fileInfo = await safeStat(fullPath)
  if (!fileInfo || !fileInfo.isFile()) {
    return null
  }

  let blob = Bun.file(fullPath)
  if (!(await blob.exists())) {
    return null
  }

  return new File([blob], posix.basename(normalizedKey), {
    type: blob.type || '',
    lastModified: fileInfo.mtimeMs,
  })
}

export async function deleteStoredFile(key: string) {
  let normalizedKey = normalizeRequiredPath(key)
  let fullPath = resolveStoragePath(normalizedKey)

  try {
    await unlink(fullPath)
  } catch (error) {
    if (!isNoEntryError(error)) {
      throw error
    }
    return
  }

  await pruneEmptyDirectories(dirname(fullPath))
}

export async function listStoredFiles(options?: {
  path?: string
  recursive?: boolean
}): Promise<StoredFile[]> {
  let normalizedPath = normalizeOptionalRelativePath(options?.path)
  let recursive = options?.recursive ?? true

  if (!recursive) {
    let { files } = await listDirectoryEntries(normalizedPath)
    return files
  }

  let files: StoredFile[] = []
  let absolutePath = resolveStoragePath(normalizedPath)
  await collectFiles(absolutePath, normalizedPath, files)
  return files.sort((a, b) => b.lastModified - a.lastModified)
}

export async function listDirectoryEntries(path?: string): Promise<DirectoryListing> {
  let normalizedPath = normalizeOptionalRelativePath(path)
  let absolutePath = resolveStoragePath(normalizedPath)

  let existing = await safeStat(absolutePath)
  if (existing && !existing.isDirectory()) {
    throw new Error('Requested path is not a directory')
  }

  await mkdir(absolutePath, { recursive: true })

  let entries: Dirent[] = []
  try {
    entries = await readdir(absolutePath, { withFileTypes: true })
  } catch (error) {
    if (!isNoEntryError(error)) {
      throw error
    }
  }

  let directories: StoredDirectory[] = []
  let files: StoredFile[] = []

  for (let entry of entries) {
    if (isJunkSegment(entry.name)) {
      continue
    }

    let entryRelative = normalizedPath ? posix.join(normalizedPath, entry.name) : entry.name
    let entryPath = join(absolutePath, entry.name)

    if (entry.isDirectory()) {
      let entryStats = await safeStat(entryPath)
      directories.push({
        key: entryRelative,
        name: entry.name,
        lastModified: entryStats?.mtimeMs ?? Date.now(),
      })
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    let stats = await safeStat(entryPath)
    if (!stats) continue

    let blob = Bun.file(entryPath)
    files.push({
      key: entryRelative,
      name: entry.name,
      size: stats.size,
      type: blob.type || 'application/octet-stream',
      lastModified: stats.mtimeMs,
    })
  }

  directories.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

  return {
    path: normalizedPath,
    directories,
    files,
  }
}

export async function listDirectoryTree(): Promise<DirectoryTreeNode[]> {
  let nodes = await collectDirectoryTree(storageRoot, '')
  nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return nodes
}

export async function createStoredDirectory(path: string) {
  let normalizedPath = normalizeRequiredPath(path)
  if (!normalizedPath) {
    throw new Error('Directory path cannot be empty')
  }

  let absolutePath = resolveStoragePath(normalizedPath)
  let existing = await safeStat(absolutePath)
  if (existing) {
    if (existing.isDirectory()) {
      return
    }
    throw new Error('A file already exists at that path')
  }

  await mkdir(absolutePath, { recursive: true })
}

export async function deleteStoredDirectory(path: string) {
  let normalizedPath = normalizeRequiredPath(path)
  if (!normalizedPath) {
    throw new Error('Directory path cannot be empty')
  }

  let absolutePath = resolveStoragePath(normalizedPath)
  let existing = await safeStat(absolutePath)
  if (!existing) {
    return
  }

  if (!existing.isDirectory()) {
    throw new Error('Requested path is not a directory')
  }

  await rm(absolutePath, { recursive: true, force: true })
  await pruneEmptyDirectories(dirname(absolutePath))
}

export function publicPathForKey(key: string) {
  return `/uploads/${key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`
}

async function collectFiles(directory: string, relativePath: string, files: StoredFile[]) {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isNoEntryError(error)) {
      return
    }
    throw error
  }

  for (let entry of entries) {
    if (isJunkSegment(entry.name)) {
      continue
    }

    let entryRelative = relativePath ? posix.join(relativePath, entry.name) : entry.name
    let entryPath = join(directory, entry.name)

    if (entry.isDirectory()) {
      await collectFiles(entryPath, entryRelative, files)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    let stats = await safeStat(entryPath)
    if (!stats) continue

    let blob = Bun.file(entryPath)
    files.push({
      key: entryRelative,
      name: entry.name,
      size: stats.size,
      type: blob.type || 'application/octet-stream',
      lastModified: stats.mtimeMs,
    })
  }
}

async function collectDirectoryTree(directory: string, relativePath: string) {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isNoEntryError(error)) {
      return []
    }
    throw error
  }

  let nodes: DirectoryTreeNode[] = []

  for (let entry of entries) {
    if (!entry.isDirectory() || isJunkSegment(entry.name)) {
      continue
    }

    let entryRelative = relativePath ? posix.join(relativePath, entry.name) : entry.name
    let entryPath = join(directory, entry.name)
    let children = await collectDirectoryTree(entryPath, entryRelative)

    nodes.push({
      key: entryRelative,
      name: entry.name,
      children: children.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      ),
    })
  }

  nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return nodes
}

async function ensureUniqueKey(initialKey: string) {
  let { dir, name, ext } = posix.parse(initialKey)
  let counter = 1
  let candidate = initialKey

  while (true) {
    let fullPath = resolveStoragePath(candidate)
    let stats = await safeStat(fullPath)
    if (!stats) {
      return candidate
    }

    let suffix = ` (${counter})`
    candidate = dir ? posix.join(dir, `${name}${suffix}${ext}`) : `${name}${suffix}${ext}`
    counter += 1
  }
}

function buildInitialKey(prefix: string, filename: string) {
  let safeName = sanitizeFileName(filename)
  return prefix ? posix.join(prefix, safeName) : safeName
}

function joinNormalized(prefix: string, segment: string) {
  if (!prefix) return segment
  if (!segment) return prefix
  return `${prefix}/${segment}`
}

export function isIgnoredUpload(file: File, normalizedRelativePath?: string) {
  if (isJunkSegment(file.name)) {
    return true
  }

  let relative =
    normalizedRelativePath ??
    ((): string => {
      let extracted = extractRelativePath(file)
      return extracted ? normalizeOptionalRelativePath(extracted) : ''
    })()

  if (!relative) {
    return false
  }

  return isJunkPath(relative)
}

function sanitizeFileName(name: string) {
  let trimmed = name.trim().replace(/[/\\]/g, '-')
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    return 'untitled'
  }
  return trimmed
}

function normalizeRequiredPath(input: string) {
  let normalized = normalizeOptionalRelativePath(input)
  if (!normalized) {
    throw new Error('Storage key cannot be empty')
  }
  return normalized
}

function normalizeOptionalRelativePath(input?: string) {
  if (!input) {
    return ''
  }

  let replaced = input.replace(/\\/g, '/')
  let segments = replaced.split('/').filter((segment) => segment.length > 0)

  for (let segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error('Relative paths cannot contain navigation segments')
    }
  }

  return segments.join('/')
}

function extractRelativePath(file: File) {
  let candidate = (file as File & { webkitRelativePath?: string }).webkitRelativePath

  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate.replace(/\\/g, '/').replace(/^\/+/, '')
  }

  if (typeof file.name === 'string') {
    if (file.name.includes('/') || file.name.includes('\\')) {
      return file.name.replace(/\\/g, '/').replace(/^\/+/, '')
    }
  }

  return ''
}

function parseRelativeUploadPath(relativePath: string) {
  if (!relativePath) {
    return { path: '', isDirectory: false }
  }

  let replaced = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  let isDirectory = replaced.endsWith('/')
  let withoutTrailing = isDirectory ? replaced.replace(/\/+$/, '') : replaced
  let normalized = normalizeOptionalRelativePath(withoutTrailing)

  return { path: normalized, isDirectory }
}

function isJunkPath(path: string) {
  return path.split('/').some((segment) => isJunkSegment(segment))
}

function isJunkSegment(segment: string | undefined | null) {
  if (typeof segment !== 'string') {
    return true
  }

  let trimmed = segment.trim()
  if (trimmed.length === 0) {
    return true
  }

  let lower = trimmed.toLowerCase()
  if (junkExactNames.has(lower)) {
    return true
  }

  for (let prefix of junkPrefixPatterns) {
    if (lower.startsWith(prefix)) {
      return true
    }
  }

  return false
}

export async function moveStoredEntries(
  entries: string[],
  destination: string,
): Promise<MoveStoredEntriesResult> {
  if (entries.length === 0) {
    return { entries: [], files: [] }
  }

  let normalizedDestination = normalizeOptionalRelativePath(destination)
  if (normalizedDestination) {
    let destinationPath = resolveStoragePath(normalizedDestination)
    await mkdir(destinationPath, { recursive: true })
  }

  let uniqueEntries = Array.from(new Set(entries.map((entry) => normalizeRequiredPath(entry))))

  uniqueEntries.sort((a, b) => {
    let depthDiff = a.split('/').length - b.split('/').length
    if (depthDiff !== 0) return depthDiff
    return a.localeCompare(b)
  })

  let filteredEntries: string[] = []
  for (let entry of uniqueEntries) {
    let hasAncestor = filteredEntries.some(
      (candidate) => candidate !== entry && entry.startsWith(`${candidate}/`),
    )
    if (hasAncestor) {
      continue
    }
    filteredEntries.push(entry)
  }

  let movedEntries: MovedEntry[] = []
  let fileReplacements: FileReplacement[] = []

  for (let entry of filteredEntries) {
    let oldPath = resolveStoragePath(entry)
    let stats = await safeStat(oldPath)
    if (!stats) {
      throw new Error(`Entry not found: ${entry}`)
    }

    let baseName = posix.basename(entry)
    let targetKey = normalizedDestination ? posix.join(normalizedDestination, baseName) : baseName

    if (targetKey === entry) {
      continue
    }

    if (targetKey.startsWith(`${entry}/`)) {
      throw new Error('Cannot move a folder into itself.')
    }

    let targetPath = resolveStoragePath(targetKey)
    let existingTarget = await safeStat(targetPath)
    if (existingTarget) {
      throw new Error(`Destination already contains “${baseName}”.`)
    }

    await mkdir(dirname(targetPath), { recursive: true })

    if (stats.isDirectory()) {
      let descendants = await listStoredFiles({ path: entry, recursive: true })
      await rename(oldPath, targetPath)
      await pruneEmptyDirectories(dirname(oldPath))

      movedEntries.push({ from: entry, to: targetKey, kind: 'directory' })

      for (let file of descendants) {
        let relative = file.key.slice(entry.length)
        let replacementTarget = relative.length > 0 ? `${targetKey}${relative}` : targetKey
        fileReplacements.push({ from: file.key, to: replacementTarget })
      }
    } else if (stats.isFile()) {
      await rename(oldPath, targetPath)
      await pruneEmptyDirectories(dirname(oldPath))
      movedEntries.push({ from: entry, to: targetKey, kind: 'file' })
      fileReplacements.push({ from: entry, to: targetKey })
    }
  }

  return { entries: movedEntries, files: fileReplacements }
}

function resolveStoragePath(key: string) {
  let segments = key.split('/').filter(Boolean)
  let absolutePath = resolve(storageRoot, ...segments)

  if (!absolutePath.startsWith(storageRootWithSep) && absolutePath !== storageRoot) {
    throw new Error('Computed path escapes storage root')
  }

  return absolutePath
}

async function safeStat(pathname: string) {
  try {
    return await stat(pathname)
  } catch (error) {
    if (isNoEntryError(error)) {
      return null
    }
    throw error
  }
}

async function pruneEmptyDirectories(start: string) {
  let current = resolve(start)

  while (current.startsWith(storageRootWithSep) && current !== storageRoot) {
    let entries = await readdir(current)
    if (entries.length > 0) {
      break
    }

    await rm(current, { recursive: false })
    current = dirname(current)
  }
}

function isNoEntryError(error: unknown): error is NodeJS.ErrnoException {
  return (
    Boolean(error) &&
    typeof error === 'object' &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
