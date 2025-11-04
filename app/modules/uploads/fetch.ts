import { getStoredFile } from '../../utils/uploads.ts'

export async function serveUploadedFile(key: string | undefined) {
  if (typeof key !== 'string' || key.length === 0) {
    return new Response('File key is required', { status: 404 })
  }

  let file = await getStoredFile(key)

  if (!file) {
    return new Response('File not found', { status: 404 })
  }

  return new Response(file, {
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'Content-Length': file.size.toString(),
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      Expires: '0',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
