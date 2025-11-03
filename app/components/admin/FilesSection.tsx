import { routes } from '../../../routes.ts'
import type { AdminFile } from '../../models/admin.server.ts'
import { getPublicFileUrl } from '../../models/admin.server.ts'
import { formatBytes, formatDate } from '../../utils/format.ts'

type FilesSectionProps = {
  files: AdminFile[]
}

export function FilesSection({ files }: FilesSectionProps) {
  return (
    <section>
      <h3>Stored files</h3>
      <p>Select files to include in a download link or manage existing assets.</p>

      <form id="download-share-form" method="POST" action={routes.admin.createDownloadShare.href()}>
        <p>
          <label>
            Expires in (minutes):
            <input type="number" name="expiresIn" min="5" step="5" />
          </label>
        </p>
        <button type="submit">Generate download link</button>
      </form>

      {files.length === 0 ? (
        <p>No files uploaded yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Select</th>
              <th>File</th>
              <th>Type</th>
              <th>Size</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr key={file.key}>
                <td>
                  <input type="checkbox" name="keys" value={file.key} form="download-share-form" />
                </td>
                <td>
                  <strong>{file.name}</strong>
                  <div>
                    <code>{file.key}</code>
                  </div>
                </td>
                <td>{file.type || 'n/a'}</td>
                <td>{formatBytes(file.size)}</td>
                <td>{formatDate(file.lastModified)}</td>
                <td>
                  <a href={getPublicFileUrl(file.key)} target="_blank" rel="noreferrer">
                    Open
                  </a>
                  {' | '}
                  <form method="POST" action={routes.admin.deleteFile.href()}>
                    <input type="hidden" name="key" value={file.key} />
                    <button type="submit">Delete</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
