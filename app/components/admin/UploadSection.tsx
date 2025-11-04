import { routes } from '../../../routes.ts'
import {
  cardClass,
  fileInputClass,
  primaryButtonClass,
  secondaryButtonClass,
  sectionDescriptionClass,
  sectionTitleClass,
} from '../ui.ts'

type UploadSectionProps = {
  currentPath: string
}

export function UploadSection({ currentPath }: UploadSectionProps) {
  let destinationLabel = currentPath ? `/${currentPath}` : '/'

  return (
    <section
      className={`${cardClass} flex h-full flex-col gap-6`}
      data-upload-share-root
      data-share-token=""
    >
      <header>
        <h3 className={sectionTitleClass}>Upload new files</h3>
        <p className={sectionDescriptionClass}>
          Add batches of files to your storage bucket. Use the folder sidebar to create structure,
          then move uploads into place once they finish.
        </p>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Destination: <span className="text-slate-200">{destinationLabel}</span>
        </p>
      </header>
      <div className="rounded-xl border border-slate-800/80 bg-slate-950/70 px-4 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-100">Upload mode</p>
            <p className="text-xs text-slate-400">
              Resumable uploads are enabled by default and keep progress after interruptions. Toggle
              off for the standard form when you need a quick fallback.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border border-slate-500 bg-slate-900 accent-sky-400 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
              data-upload-resumable-toggle
              defaultChecked
            />
            <span>Resumable</span>
          </label>
        </div>
      </div>
      <form
        method="POST"
        action={routes.admin.upload.href()}
        encType="multipart/form-data"
        className="space-y-4"
        data-upload-share-form
      >
        <input type="hidden" name="path" value={currentPath} data-upload-path />
        <div className="space-y-4" data-upload-standard-panel>
          <label className="block text-sm font-medium text-slate-200">
            Select files
            <input type="file" name="files" multiple required className={fileInputClass} />
          </label>
          <p className="text-xs text-slate-400">
            Hidden system files are skipped automatically. Create folders above and move files to
            keep things organized.
          </p>
          <button type="submit" className={`${primaryButtonClass} w-full`} data-upload-submit>
            Upload files
          </button>
        </div>
        <div className="hidden space-y-4" data-upload-resumable-panel aria-hidden="true" hidden>
          <div className="rounded-xl border border-slate-800/70 bg-slate-950/70 px-2 py-2">
            <div data-uppy-root className="min-h-[20rem]" />
          </div>
          <p className="text-xs text-slate-400">
            Powered by Uppy. Uploads resume automatically if the network drops. Leave this tab open
            until everything finishes. Drag folders or use the Add button to include entire
            directories.
          </p>
        </div>
      </form>
    </section>
  )
}
