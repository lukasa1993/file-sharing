import { uploadsStorage } from '../../utils/uploads.ts'

export async function serveUploadedFile(key: string) {
  let file = await uploadsStorage.get(key)

  if (!file) {
    return new Response('File not found', { status: 404 })
  }

  return new Response(file, {
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'Content-Length': file.size.toString(),
      'Cache-Control': 'public, max-age=31536000',
    },
  })
}
