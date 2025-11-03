import { routes } from '../../../routes.ts'
import type { AdminFile } from '../../models/admin.server.ts'
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
} from '../ui.ts'

type FilesSectionProps = {
  files: AdminFile[]
}

export function FilesSection({ files }: FilesSectionProps) {
  let hasFiles = files.length > 0

  return (
    <section className={`${cardClass} space-y-6`}>
      <header>
        <h3 className={sectionTitleClass}>Stored files</h3>
        <p className={sectionDescriptionClass}>
          Select assets to include in a download link or manage existing uploads in your storage
          bucket.
        </p>
      </header>

      <form
        id="download-share-form"
        method="POST"
        action={routes.admin.createDownloadShare.href()}
        className="flex flex-col gap-4 rounded-2xl border border-slate-800/80 bg-slate-950/60 p-4 sm:flex-row sm:items-end sm:gap-6"
      >
        <label className="flex flex-1 flex-col text-sm font-medium text-slate-200 sm:max-w-xs">
          Expires in (minutes)
          <input type="number" name="expiresIn" min="5" step="5" className={inputClass} />
        </label>
        <button type="submit" className={primaryButtonClass}>
          Generate download link
        </button>
      </form>

      {hasFiles ? (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-800/80 text-left text-sm">
            <thead className="bg-slate-900/70 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3">Select</th>
                <th className="px-4 py-3">File</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Size</th>
                <th className="px-4 py-3">Updated</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {files.map((file) => (
                <tr key={file.key} className="hover:bg-slate-900/40">
                  <td className="px-4 py-4 align-middle">
                    <input
                      type="checkbox"
                      name="keys"
                      value={file.key}
                      form="download-share-form"
                      className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-sky-400 transition focus:ring-sky-400/60"
                    />
                  </td>
                  <td className="px-4 py-4 align-middle">
                    <div className="font-semibold text-slate-100">{file.name}</div>
                    <div className="mt-1 text-xs text-slate-400">
                      Key: <code className="rounded bg-slate-900/80 px-1.5 py-0.5">{file.key}</code>
                    </div>
                  </td>
                  <td className="px-4 py-4 align-middle text-slate-300">
                    {file.type || 'n/a'}
                  </td>
                  <td className="px-4 py-4 align-middle text-slate-300">
                    {formatBytes(file.size)}
                  </td>
                  <td className="px-4 py-4 align-middle text-slate-300">
                    {formatDate(file.lastModified)}
                  </td>
                  <td className="px-4 py-4 align-middle">
                    <div className="flex items-center justify-end gap-3">
                      <a
                        href={getPublicFileUrl(file.key)}
                        target="_blank"
                        rel="noreferrer"
                        className={`${secondaryButtonClass} px-3 py-1.5 text-xs font-semibold`}
                      >
                        Open
                      </a>
                      <form method="POST" action={routes.admin.deleteFile.href()}>
                        <input type="hidden" name="key" value={file.key} />
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
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-slate-800/70 bg-slate-950/40 px-4 py-6 text-sm text-slate-400">
          No files uploaded yet. Add some assets to start sharing.
        </p>
      )}
    </section>
  )
}
