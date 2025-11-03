import { routes } from '../../../routes.ts'
import {
  cardClass,
  inputClass,
  primaryButtonClass,
  sectionDescriptionClass,
  sectionTitleClass,
} from '../ui.ts'

export function RequestUploadsSection() {
  return (
    <section className={`${cardClass} flex h-full flex-col gap-6`}>
      <header>
        <h3 className={sectionTitleClass}>Request uploads</h3>
        <p className={sectionDescriptionClass}>
          Create a secure link that lets collaborators upload files directly without giving them
          full storage access.
        </p>
      </header>
      <form
        method="POST"
        action={routes.admin.createUploadShare.href()}
        className="space-y-4"
      >
        <label className="block text-sm font-medium text-slate-200">
          Expires in (minutes)
          <input type="number" name="expiresIn" min="5" step="5" className={inputClass} />
        </label>
        <label className="block text-sm font-medium text-slate-200">
          Max files
          <input type="number" name="maxFiles" min="1" step="1" className={inputClass} />
        </label>
        <button type="submit" className={primaryButtonClass}>
          Generate upload link
        </button>
      </form>
    </section>
  )
}
