import { routes } from '../../../routes.ts'
import {
  cardClass,
  fileInputClass,
  primaryButtonClass,
  sectionDescriptionClass,
  sectionTitleClass,
} from '../ui.ts'

type UploadSectionProps = {
  currentPath: string
}

export function UploadSection({ currentPath }: UploadSectionProps) {
  let destinationLabel = currentPath ? `/${currentPath}` : '/'

  return (
    <section className={`${cardClass} flex h-full flex-col gap-6`}>
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
      <form
        method="POST"
        action={routes.admin.upload.href()}
        encType="multipart/form-data"
        className="space-y-4"
      >
        <input type="hidden" name="path" value={currentPath} />
        <label className="block text-sm font-medium text-slate-200">
          Select files
          <input type="file" name="files" multiple required className={fileInputClass} />
        </label>
        <p className="text-xs text-slate-400">
          Hidden system files are skipped automatically. Create folders above and move files to keep
          things organized.
        </p>
        <button type="submit" className={primaryButtonClass}>
          Upload files
        </button>
      </form>
    </section>
  )
}
