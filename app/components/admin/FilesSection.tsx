import { routes } from '../../../routes.ts'
import type { AdminDirectoryListing } from '../../models/admin.server.ts'
import { getPublicFileUrl } from '../../models/admin.server.ts'
import { formatBytes, formatDate } from '../../utils/format.ts'
import {
  cardClass,
  dangerButtonClass,
  inputClass,
  primaryButtonClass,
  sectionDescriptionClass,
  sectionTitleClass,
  secondaryButtonClass,
  inlineLinkClass,
} from '../ui.ts'

type HrefForPath = (targetPath: string, options?: { selection?: string[] }) => string

type FilesSectionProps = {
  directory: AdminDirectoryListing
  hrefForPath: HrefForPath
  selectedEntries: string[]
}

type Breadcrumb = {
  label: string
  path: string
}

type DirectoryEntry = AdminDirectoryListing['directories'][number]
type FileEntry = AdminDirectoryListing['files'][number]

type FilesTableEntry =
  | { kind: 'directory'; entry: DirectoryEntry }
  | { kind: 'file'; entry: FileEntry }

export function FilesSection({ directory, hrefForPath, selectedEntries }: FilesSectionProps) {
  let { path, directories, files } = directory
  let breadcrumbs = buildBreadcrumbs(path)
  let entries: FilesTableEntry[] = [
    ...directories.map((directoryEntry) => ({ kind: 'directory', entry: directoryEntry })),
    ...files.map((fileEntry) => ({ kind: 'file', entry: fileEntry })),
  ]
  let hasEntries = entries.length > 0
  let bulkActionFormId = 'bulk-action-form'
  let selectedEntriesSet = new Set(selectedEntries)
  let currentTokens = new Set(
    entries.map((entry) =>
      entry.kind === 'directory' ? directoryToken(entry.entry) : fileToken(entry.entry),
    ),
  )
  let persistedSelections = selectedEntries.filter((value) => !currentTokens.has(value))
  let selectionCount = selectedEntries.length
  let clearSelectionHref = hrefForPath(path, { selection: [] })

  return (
    <section id="files" className={`${cardClass} space-y-6`}>
      <header className="space-y-3">
        <h3 className={sectionTitleClass}>Stored files</h3>
        <p className={sectionDescriptionClass}>
          Browse folders just like you would in Finder or Explorer. Select files or folders, then
          move or share them in bulk. Navigate into deeper folders without losing the items you have
          already checked.
        </p>
      </header>

      <form
        id={bulkActionFormId}
        method="POST"
        action={routes.admin.createDownloadShare.href()}
        className="flex flex-col gap-4 rounded-2xl border border-slate-800/80 bg-slate-950/60 p-4"
      >
        <input type="hidden" name="currentPath" value={path} />
        {persistedSelections.map((value) => (
          <input key={`persisted-${value}`} type="hidden" name="selection" value={value} />
        ))}

        <div className="flex flex-col gap-4 lg:flex-row lg:flex-wrap lg:items-end lg:justify-between">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <label className="flex flex-col text-xs font-semibold uppercase tracking-wide text-slate-400 sm:max-w-[12rem]">
              Expires in (minutes)
              <input type="number" name="expiresIn" min="0" step="1" className={inputClass} />
              <span className="mt-1 text-[10px] font-medium normal-case text-slate-500">
                Use 0 for no expiry.
              </span>
            </label>
            <button type="submit" className={`${primaryButtonClass} w-full sm:w-auto`}>
              Generate download link
            </button>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <label className="flex flex-col text-xs font-semibold uppercase tracking-wide text-slate-400 sm:max-w-[12rem]">
              New folder name
              <input
                type="text"
                name="name"
                autoComplete="off"
                placeholder="Documents"
                className={inputClass}
              />
            </label>
            <button
              type="submit"
              formAction={routes.admin.createDirectory.href()}
              className={`${secondaryButtonClass} w-full text-xs font-semibold uppercase tracking-wide sm:w-auto sm:self-end`}
            >
              Create folder
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2 text-xs text-slate-400 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              formAction={routes.admin.moveEntries.href()}
              name="destination"
              value=""
              className={`${secondaryButtonClass} px-3 py-1.5 text-xs font-semibold uppercase tracking-wide`}
              title="Move the selected items to the root folder"
            >
              Move selection to root
            </button>
            {path ? (
              <button
                type="submit"
                formAction={routes.admin.moveEntries.href()}
                name="destination"
                value={path}
                className={`${secondaryButtonClass} px-3 py-1.5 text-xs font-semibold uppercase tracking-wide`}
                title="Move the selected items to this folder"
              >
                Move selection here
              </button>
            ) : null}
          </div>
        </div>

        {selectionCount > 0 ? (
          <div className="rounded-xl border border-slate-800/70 bg-slate-950/40 p-3 text-xs text-slate-300">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold uppercase tracking-wide">
                {selectionCount} item{selectionCount === 1 ? '' : 's'} selected
              </p>
              <a href={clearSelectionHref} className={inlineLinkClass}>
                Clear selection
              </a>
            </div>
            <ul className="mt-2 space-y-1">
              {selectedEntries.map((token) => {
                let updatedSelection = selectedEntries.filter((value) => value !== token)
                return (
                  <li
                    key={`selection-${token}`}
                    className="flex flex-wrap items-center justify-between gap-2"
                  >
                    <span className="font-medium text-slate-200">
                      {formatSelectionLabel(token)}
                    </span>
                    <a
                      href={hrefForPath(path, { selection: updatedSelection })}
                      className={`${inlineLinkClass} text-xs uppercase tracking-wide`}
                    >
                      Remove
                    </a>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
      </form>

      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {breadcrumbs.map((crumb, index) => {
            let isLast = index === breadcrumbs.length - 1
            return (
              <li key={`${crumb.path}-${index}`} className="flex items-center gap-1">
                {index > 0 ? <span className="text-slate-700">/</span> : null}
                {isLast ? (
                  <span className="text-slate-200">{crumb.label}</span>
                ) : (
                  <a
                    href={hrefForPath(crumb.path)}
                    className="rounded px-1 py-0.5 text-slate-300 transition hover:text-sky-300"
                  >
                    {crumb.label}
                  </a>
                )}
              </li>
            )
          })}
        </ol>
      </nav>

      {hasEntries ? (
        <div className="overflow-x-auto rounded-2xl border border-slate-800/80">
          <table className="min-w-full divide-y divide-slate-800/80 text-left text-sm">
            <thead className="bg-slate-900/70 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3">Select</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Size</th>
                <th className="px-4 py-3">Updated</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {entries.map((entry) => {
                if (entry.kind === 'directory') {
                  let directoryEntry = entry.entry
                  let token = directoryToken(directoryEntry)
                  return (
                    <tr key={`directory:${directoryEntry.key}`} className="hover:bg-slate-900/40">
                      <td className="px-4 py-4 align-middle">
                        <input
                          type="checkbox"
                          name="selection"
                          value={token}
                          form={bulkActionFormId}
                          aria-label={`Select ${directoryEntry.name}`}
                          defaultChecked={selectedEntriesSet.has(token)}
                          className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-sky-400 transition focus:ring-sky-400/60"
                        />
                      </td>
                      <td className="px-4 py-4 align-middle">
                        <a
                          href={hrefForPath(directoryEntry.key)}
                          className="font-semibold text-slate-100 transition hover:text-sky-300"
                        >
                          {directoryEntry.name}
                        </a>
                        <div className="mt-1 text-xs text-slate-500">
                          Path:{' '}
                          <code className="rounded bg-slate-900/80 px-1.5 py-0.5 text-slate-300">
                            /{directoryEntry.key}
                          </code>
                        </div>
                      </td>
                      <td className="px-4 py-4 align-middle text-slate-300">Folder</td>
                      <td className="px-4 py-4 align-middle text-slate-500">—</td>
                      <td className="px-4 py-4 align-middle text-slate-300">
                        {formatDate(directoryEntry.lastModified)}
                      </td>
                      <td className="px-4 py-4 align-middle">
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <button
                            type="submit"
                            form={bulkActionFormId}
                            formAction={routes.admin.moveEntries.href()}
                            name="destination"
                            value={directoryEntry.key}
                            className={`${secondaryButtonClass} px-3 py-1.5 text-xs font-semibold uppercase tracking-wide`}
                            title={`Move the selected items to ${directoryEntry.name}`}
                          >
                            Move selection here
                          </button>
                          <form method="POST" action={routes.admin.deleteDirectory.href()}>
                            <input type="hidden" name="directory" value={directoryEntry.key} />
                            <input type="hidden" name="path" value={path} />
                            <button
                              type="submit"
                              className={`${dangerButtonClass} px-3 py-1.5 text-xs font-semibold`}
                            >
                              Delete
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  )
                }

                let fileEntry = entry.entry
                let token = fileToken(fileEntry)
                let relativeKey =
                  path && fileEntry.key.startsWith(`${path}/`)
                    ? fileEntry.key.slice(path.length + 1)
                    : fileEntry.key

                return (
                  <tr key={`file:${fileEntry.key}`} className="hover:bg-slate-900/40">
                    <td className="px-4 py-4 align-middle">
                      <input
                        type="checkbox"
                        name="selection"
                        value={token}
                        form={bulkActionFormId}
                        aria-label={`Select ${fileEntry.name}`}
                        defaultChecked={selectedEntriesSet.has(token)}
                        className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-sky-400 transition focus:ring-sky-400/60"
                      />
                    </td>
                    <td className="px-4 py-4 align-middle">
                      <div className="font-semibold text-slate-100">{fileEntry.name}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        Path:{' '}
                        <code className="rounded bg-slate-900/80 px-1.5 py-0.5 text-slate-300">
                          /{fileEntry.key}
                        </code>
                      </div>
                      {relativeKey !== fileEntry.name ? (
                        <div className="mt-1 text-xs text-slate-500">Relative: {relativeKey}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-4 align-middle text-slate-300">
                      {fileEntry.type || 'n/a'}
                    </td>
                    <td className="px-4 py-4 align-middle text-slate-300">
                      {formatBytes(fileEntry.size)}
                    </td>
                    <td className="px-4 py-4 align-middle text-slate-300">
                      {formatDate(fileEntry.lastModified)}
                    </td>
                    <td className="px-4 py-4 align-middle">
                      <div className="flex items-center justify-end gap-3">
                        <a
                          href={getPublicFileUrl(fileEntry.key)}
                          target="_blank"
                          rel="noreferrer"
                          className={`${secondaryButtonClass} px-3 py-1.5 text-xs font-semibold`}
                        >
                          Open
                        </a>
                        <form method="POST" action={routes.admin.deleteFile.href()}>
                          <input type="hidden" name="key" value={fileEntry.key} />
                          <input type="hidden" name="path" value={path} />
                          <button
                            type="submit"
                            className={`${dangerButtonClass} px-3 py-1.5 text-xs font-semibold`}
                          >
                            Delete
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {!hasEntries ? (
        <p className="rounded-xl border border-dashed border-slate-800/70 bg-slate-950/40 px-4 py-6 text-sm text-slate-400">
          This folder is empty. Upload files or create subfolders to get started.
        </p>
      ) : null}
    </section>
  )
}

function buildBreadcrumbs(path: string): Breadcrumb[] {
  let breadcrumbs: Breadcrumb[] = [{ label: 'All files', path: '' }]

  if (!path) {
    return breadcrumbs
  }

  let segments = path.split('/')
  let current = ''

  for (let segment of segments) {
    current = current ? `${current}/${segment}` : segment
    breadcrumbs.push({
      label: segment,
      path: current,
    })
  }

  return breadcrumbs
}

function directoryToken(entry: DirectoryEntry): string {
  return `directory:${entry.key}`
}

function fileToken(entry: FileEntry): string {
  return `file:${entry.key}`
}

function formatSelectionLabel(token: string): string {
  if (token.startsWith('directory:')) {
    let key = token.slice('directory:'.length)
    return `Folder /${key}`
  }

  if (token.startsWith('file:')) {
    let key = token.slice('file:'.length)
    return `File /${key}`
  }

  return token
}
