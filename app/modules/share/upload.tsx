import {
  findShare,
  registerUploadForToken,
  revokeShareToken,
  type UploadShare,
} from '../../models/share.server.ts'
import { saveFile } from '../../utils/uploads.ts'
import { render } from '../../utils/render.ts'
import { routes } from '../../../routes.ts'
import { UploadSharePage } from '../../components/share/UploadSharePage.tsx'
import { redirectWithSearch } from '../../utils/redirect.ts'
import { shareUnavailable, uploadShareCompleted } from './responses.tsx'

export function handleUploadShareView({ token, request }: { token: string; request: Request }) {
  let share = findShare(token)

  if (!share || share.kind !== 'upload') {
    return shareUnavailable('Upload share not found or expired.')
  }

  let url = new URL(request.url)
  let message = url.searchParams.get('message')
  let error = url.searchParams.get('error')
  let actionUrl = routes.share.upload.action.href({ token })

  return render(
    <UploadSharePage
      token={token}
      share={share as UploadShare}
      actionUrl={actionUrl}
      message={message ?? undefined}
      error={error ?? undefined}
    />,
  )
}

export async function handleUploadShareAction({
  token,
  request,
}: {
  token: string
  request: Request
}) {
  let share = findShare(token)

  if (!share || share.kind !== 'upload') {
    return shareUnavailable('Upload share not found or expired.')
  }

  let formData = await request.clone().formData()
  let files = formData.getAll('files').filter((value): value is File => value instanceof File)

  if (files.length === 0) {
    return redirectToUploadShare(request, token, { error: 'Select one or more files to send.' })
  }

  if (share.maxFiles != null) {
    let remaining = share.maxFiles - share.uploadedCount
    if (remaining <= 0) {
      await revokeShareToken(token)
      return redirectToUploadShare(request, token, {
        error: 'This upload link has reached its limit.',
      })
    }

    if (files.length > remaining) {
      return redirectToUploadShare(request, token, {
        error: `Only ${remaining} upload${remaining === 1 ? '' : 's'} remaining for this link.`,
      })
    }
  }

  await Promise.all(files.map((file) => saveFile(file, { prefix: `share/${token}` })))
  await registerUploadForToken(token, files.length)

  let updatedShare = findShare(token)
  if (!updatedShare || updatedShare.kind !== 'upload') {
    return uploadShareCompleted(
      `Uploaded ${files.length} file${files.length === 1 ? '' : 's'}. This link has now reached its limit and is closed.`,
    )
  }

  return redirectToUploadShare(request, token, {
    message: `Uploaded ${files.length} file${files.length === 1 ? '' : 's'}.`,
  })
}

function redirectToUploadShare(
  request: Request,
  token: string,
  options: { message?: string; error?: string },
) {
  return redirectWithSearch(request, routes.share.upload.index.href({ token }), {
    params: {
      message: options.message,
      error: options.error,
    },
  })
}
