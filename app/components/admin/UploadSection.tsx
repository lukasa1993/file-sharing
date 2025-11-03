import { routes } from '../../../routes.ts'

export function UploadSection() {
  return (
    <section>
      <h3>Upload new files</h3>
      <form method="POST" action={routes.admin.upload.href()} encType="multipart/form-data">
        <p>
          <label>
            Files:
            <input type="file" name="files" multiple required />
          </label>
        </p>
        <button type="submit">Upload files</button>
      </form>
    </section>
  )
}
