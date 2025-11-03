import { routes } from '../../../routes.ts'

export function RequestUploadsSection() {
  return (
    <section>
      <h3>Request uploads</h3>
      <p>Generate a link that lets others send files straight into your storage folder.</p>
      <form method="POST" action={routes.admin.createUploadShare.href()}>
        <p>
          <label>
            Expires in (minutes):
            <input type="number" name="expiresIn" min="5" step="5" />
          </label>
        </p>
        <p>
          <label>
            Max files:
            <input type="number" name="maxFiles" min="1" step="1" />
          </label>
        </p>
        <button type="submit">Generate upload link</button>
      </form>
    </section>
  )
}
