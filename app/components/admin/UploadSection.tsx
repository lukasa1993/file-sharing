import { routes } from '../../../routes.ts'
import {
  cardClass,
  fileInputClass,
  primaryButtonClass,
  sectionDescriptionClass,
  sectionTitleClass,
} from '../ui.ts'

export function UploadSection() {
  return (
    <section className={`${cardClass} flex h-full flex-col gap-6`}>
      <header>
        <h3 className={sectionTitleClass}>Upload new files</h3>
        <p className={sectionDescriptionClass}>
          Add files directly to your storage bucket. You can include multiple items in one batch.
        </p>
      </header>
      <form
        method="POST"
        action={routes.admin.upload.href()}
        encType="multipart/form-data"
        className="space-y-4"
      >
        <label className="block text-sm font-medium text-slate-200">
          Select files
          <input type="file" name="files" multiple required className={fileInputClass} />
        </label>
        <button type="submit" className={primaryButtonClass}>
          Upload files
        </button>
      </form>
    </section>
  )
}
