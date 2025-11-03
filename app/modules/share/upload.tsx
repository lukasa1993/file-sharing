import type { RequestContext } from '@remix-run/fetch-router'

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
import { formatBytes } from '../../utils/format.ts'
import { readContextFormData } from '../../utils/form-data.ts'

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
  context,
}: {
  token: string
  context: RequestContext<'POST', { token: string }>
}) {
  let request = context.request
  let share = findShare(token)

  if (!share || share.kind !== 'upload') {
    return shareUnavailable('Upload share not found or expired.')
  }

  let formData = await readContextFormData(context)
  let files = formData.getAll('files').filter((value): value is File => value instanceof File)

  if (files.length === 0) {
    return redirectToUploadShare(request, token, { error: 'Select one or more files to send.' })
  }

  let totalBytes = files.reduce((total, file) => total + file.size, 0)

  if (share.maxBytes != null && share.maxBytes > 0) {
    let remaining = share.maxBytes - share.uploadedBytes
    if (remaining <= 0) {
      await revokeShareToken(token)
      return redirectToUploadShare(request, token, {
        error: 'This upload link has reached its limit.',
      })
    }

    if (totalBytes > remaining) {
      return redirectToUploadShare(request, token, {
        error: `Only ${formatBytes(remaining)} remaining for this link.`,
      })
    }
  }

  await Promise.all(files.map((file) => saveFile(file, { prefix: `share/${token}` })))
  await registerUploadForToken(token, totalBytes)

  let updatedShare = findShare(token)
  if (!updatedShare || updatedShare.kind !== 'upload') {
    return uploadShareCompleted(
      `Uploaded ${files.length} file${files.length === 1 ? '' : 's'} (${formatBytes(totalBytes)}). This link has now reached its limit and is closed.`,
    )
  }

  return redirectToUploadShare(request, token, {
    message: `Uploaded ${files.length} file${files.length === 1 ? '' : 's'} (${formatBytes(totalBytes)}).`,
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
