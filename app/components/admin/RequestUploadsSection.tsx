import { routes } from '../../../routes.ts'
import {
  cardClass,
  inputClass,
  primaryButtonClass,
  sectionDescriptionClass,
  sectionTitleClass,
} from '../ui.ts'

const byteUnitOptions = [
  { value: 'mb', label: 'MB (×1024²)' },
  { value: 'gb', label: 'GB (×1024³)' },
  { value: 'kb', label: 'KB (×1024)' },
  { value: 'b', label: 'Bytes' },
  { value: 'tb', label: 'TB (×1024⁴)' },
] as const

const inlineFieldClass =
  'rounded-xl border border-slate-700/70 bg-slate-900/50 px-3 py-2 text-sm text-slate-100 transition focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/60'

type RequestUploadsSectionProps = {
  currentPath: string
}

export function RequestUploadsSection({ currentPath }: RequestUploadsSectionProps) {
  let hasDestination = currentPath.trim().length > 0
  let destinationLabel = currentPath ? `/${currentPath}` : '/'

  return (
    <section className={`${cardClass} flex h-full flex-col gap-6`}>
      <header>
        <h3 className={sectionTitleClass}>Request uploads</h3>
        <p className={sectionDescriptionClass}>
          Create a secure link that lets collaborators upload files directly without giving them
          full storage access.
        </p>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Destination: <span className="text-slate-200">{destinationLabel}</span>
        </p>
      </header>
      {hasDestination ? (
        <form method="POST" action={routes.admin.createUploadShare.href()} className="space-y-4">
          <input type="hidden" name="path" value={currentPath} />
          <label className="block text-sm font-medium text-slate-200">
            Expires in (minutes)
            <input type="number" name="expiresIn" min="0" step="1" className={inputClass} />
            <span className="mt-1 text-xs text-slate-400">
              Enter 0 to keep the link open indefinitely.
            </span>
          </label>
          <label className="block text-sm font-medium text-slate-200">
            Max total size (leave blank for unlimited)
            <div className="mt-2 flex items-center gap-2">
              <input
                type="number"
                name="maxSizeValue"
                min="0"
                step="0.01"
                placeholder="0"
                className={`${inlineFieldClass} flex-1 min-w-0`}
              />
              <select name="maxSizeUnit" className={`${inlineFieldClass} mt-0 w-28 shrink-0`}>
                {byteUnitOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Examples: 50 MB, 1.5 GB. Use 0 or leave blank for unlimited.
            </p>
          </label>
          <button type="submit" className={`${primaryButtonClass} w-full`}>
            Generate upload link
          </button>
        </form>
      ) : (
        <p className="rounded-xl border border-dashed border-slate-800/70 bg-slate-950/50 px-4 py-5 text-sm text-slate-400">
          Select a folder in the navigator to target before requesting uploads. Upload links cannot
          deliver files to the root.
        </p>
      )}
    </section>
  )
}
