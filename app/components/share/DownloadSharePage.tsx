import type { DownloadShare } from '../../models/share.server.ts'
import { routes } from '../../../routes.ts'
import { Layout } from '../Layout.tsx'
import { formatBytes, formatDate } from '../../utils/format.ts'
import {
  cardClass,
  primaryButtonClass,
  secondaryButtonClass,
  sectionDescriptionClass,
  sectionTitleClass,
} from '../ui.ts'

type DownloadShareFile = {
  key: string
  name: string
  size: number
  type?: string
  downloadUrl: string
  lastModified: number
}

type DownloadSharePageProps = {
  share: DownloadShare
  files: DownloadShareFile[]
}

export function DownloadSharePage({ share, files }: DownloadSharePageProps) {
  let listCardClass =
    'rounded-2xl border border-slate-800/80 bg-slate-950/60 p-5 shadow-lg shadow-slate-950/40 transition hover:border-slate-700/70'
  let accordionClass =
    'overflow-hidden rounded-2xl border border-slate-800/80 bg-slate-950/60 shadow-lg shadow-slate-950/40'
  let summaryClass =
    'flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left text-slate-200 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70 marker:content-[""]'
  let tree = buildShareTree(files)
  let totalFiles = files.length
  let folderCount = countDirectories(tree)
  let rootNode: ShareDirectoryNode = { kind: 'directory', name: '', path: '', children: tree }
  let downloadAllHref = buildFolderDownloadHref(share, '')

  return (
    <Layout variant="minimal">
      <section className={`${cardClass} mx-auto w-full max-w-3xl space-y-6`}>
        <header className="space-y-4">
          <div className="space-y-3">
            <h2 className={`${sectionTitleClass} text-2xl`}>Files ready for download</h2>
            <p className={sectionDescriptionClass}>
              These files were securely shared by an administrator. Download them before the link
              expires or is revoked.
            </p>
          </div>
          <div className="rounded-xl border border-slate-800/80 bg-slate-950/60 px-4 py-3 text-xs uppercase tracking-wide text-slate-400">
            <div className="flex flex-col gap-1">
              <span className="text-slate-200">
                {share.expiresAt
                  ? `Link expires ${formatDate(share.expiresAt.getTime())}`
                  : 'No expiry set for this link'}
              </span>
              <span>
                {formatItemCount(totalFiles, 'file')}
                {folderCount > 0 ? ` across ${formatItemCount(folderCount, 'folder')}` : ''}
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <a
              href={downloadAllHref}
              className={`${primaryButtonClass} inline-flex w-full justify-center sm:w-auto`}
            >
              Download everything (.zip)
            </a>
            <span className="text-xs text-slate-500 sm:text-right">
              Bundles the entire folder tree into a single ZIP archive that opens cleanly on Finder,
              Files, and Explorer.
            </span>
          </div>
        </header>
        <div className="space-y-4">{renderShareNode(rootNode, 0)}</div>
      </section>
    </Layout>
  )

  function renderShareNode(node: ShareTreeNode, depth: number): JSX.Element {
    if (node.kind === 'directory') {
      let indentClass = indentClassForDepth(depth)
      let fileCount = countFiles(node)
      let nestedFolderCount = node.children.filter((child) => child.kind === 'directory').length
      let pathLabel = node.path ? `/${node.path}` : '/'
      let isRoot = node.path.length === 0
      let downloadHref = buildFolderDownloadHref(share, node.path)
      let downloadLabel = isRoot ? 'Download everything (.zip)' : 'Download folder (.zip)'
      let hasChildren = node.children.length > 0

      return (
        <div key={`directory-${node.path || 'root'}`} className={indentClass}>
          <details className={accordionClass} {...(depth === 0 ? { open: true } : {})}>
            <summary className={summaryClass}>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-white">{node.name || 'Shared files'}</p>
                <p className="text-xs uppercase tracking-wide text-slate-500">{pathLabel}</p>
              </div>
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                {formatFolderSummary(fileCount, nestedFolderCount)}
              </span>
            </summary>
            <div className="space-y-4 border-t border-slate-800/70 px-4 py-4">
              <div className="flex flex-wrap items-center justify-end gap-3">
                <a
                  href={downloadHref}
                  className={`${secondaryButtonClass} inline-flex items-center justify-center`}
                >
                  {downloadLabel}
                </a>
              </div>
              {hasChildren ? (
                <div className="space-y-4">
                  {node.children.map((child) => renderShareNode(child, depth + 1))}
                </div>
              ) : (
                <p className="rounded-xl border border-dashed border-slate-800/70 bg-slate-950/40 px-3 py-4 text-sm text-slate-400">
                  This folder is empty.
                </p>
              )}
            </div>
          </details>
        </div>
      )
    }

    let indentClass = indentClassForDepth(depth)
    let parentPath = parentDirectoryFromKey(node.file.key)

    return (
      <div key={`file-${node.path}`} className={indentClass}>
        <div className={listCardClass}>
          <div className="space-y-3">
            <div>
              <h3 className="text-lg font-semibold text-white">{node.file.name}</h3>
              <p className="text-xs uppercase tracking-wide text-slate-500">
                {node.file.type || 'Binary'}
              </p>
              {parentPath ? (
                <p className="mt-2 text-xs text-slate-500">
                  <span className="font-medium text-slate-300">Folder</span>{' '}
                  <code className="rounded bg-slate-900/80 px-1.5 py-0.5 text-slate-300">
                    /{parentPath}
                  </code>
                </p>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs text-slate-400">
              <span className="font-medium text-slate-300">Size</span>
              <span>{formatBytes(node.file.size)}</span>
              <span className="font-medium text-slate-300">Updated</span>
              <span>{formatDate(node.file.lastModified)}</span>
            </div>
            <a
              href={node.file.downloadUrl}
              download={node.file.name}
              className={`${primaryButtonClass} inline-flex w-full justify-center`}
            >
              Download
            </a>
          </div>
        </div>
      </div>
    )
  }
}

type ShareDirectoryNode = {
  kind: 'directory'
  name: string
  path: string
  children: ShareTreeNode[]
}

type ShareFileNode = {
  kind: 'file'
  name: string
  path: string
  file: DownloadShareFile
}

type ShareTreeNode = ShareDirectoryNode | ShareFileNode

function buildShareTree(files: DownloadShareFile[]): ShareTreeNode[] {
  let root: ShareDirectoryNode = { kind: 'directory', name: '', path: '', children: [] }
  let directories = new Map<string, ShareDirectoryNode>()
  directories.set('', root)

  for (let file of files) {
    let segments = file.key.split('/').filter((segment) => segment.length > 0)
    let fileName = segments.pop() ?? file.name
    let currentPath = ''
    let parent = root

    for (let segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      let existing = directories.get(currentPath)
      if (!existing) {
        let directory: ShareDirectoryNode = {
          kind: 'directory',
          name: segment,
          path: currentPath,
          children: [],
        }
        directories.set(currentPath, directory)
        parent.children.push(directory)
        parent = directory
        continue
      }
      parent = existing
    }

    let fileNode: ShareFileNode = {
      kind: 'file',
      name: fileName,
      path: file.key,
      file,
    }
    parent.children.push(fileNode)
  }

  sortDirectoryChildren(root)
  return root.children
}

function sortDirectoryChildren(directory: ShareDirectoryNode) {
  directory.children.sort((left, right) => {
    if (left.kind === right.kind) {
      return left.name.localeCompare(right.name)
    }
    return left.kind === 'directory' ? -1 : 1
  })

  for (let child of directory.children) {
    if (child.kind === 'directory') {
      sortDirectoryChildren(child)
    }
  }
}

function countFiles(node: ShareTreeNode): number {
  if (node.kind === 'file') {
    return 1
  }

  let total = 0
  for (let child of node.children) {
    total += countFiles(child)
  }
  return total
}

function countDirectories(nodes: ShareTreeNode[]): number {
  let total = 0
  for (let node of nodes) {
    if (node.kind === 'directory') {
      total += 1 + countDirectories(node.children)
    }
  }
  return total
}

function indentClassForDepth(depth: number) {
  let classes = ['pl-0', 'pl-4', 'pl-8', 'pl-12', 'pl-16', 'pl-20', 'pl-24']
  let index = depth
  if (index < 0) index = 0
  if (index >= classes.length) index = classes.length - 1
  return classes[index]
}

function parentDirectoryFromKey(key: string) {
  let segments = key.split('/').filter((segment) => segment.length > 0)
  if (segments.length <= 1) {
    return undefined
  }
  segments.pop()
  return segments.join('/')
}

function formatItemCount(count: number, noun: 'file' | 'folder') {
  if (count === 1) {
    return `1 ${noun}`
  }
  return `${count} ${noun}s`
}

function formatFolderSummary(fileCount: number, folderCount: number) {
  let parts = [formatItemCount(fileCount, 'file')]
  if (folderCount > 0) {
    parts.push(formatItemCount(folderCount, 'folder'))
  }
  return parts.join(' · ')
}

function buildFolderDownloadHref(share: DownloadShare, path: string | undefined) {
  let base = routes.share.download.href({ token: share.token })
  if (path == null || path === '') {
    return `${base}?folder=`
  }
  return `${base}?folder=${encodeURIComponent(path)}`
}
