import type { RequestContext } from '@remix-run/fetch-router'

import {
  findShare,
  registerUploadForToken,
  revokeShareToken,
  type UploadShare,
} from '../../models/share.server.ts'
import { isIgnoredUpload, saveFile } from '../../utils/uploads.ts'
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

  let uploadableFiles = files.filter((file) => !isIgnoredUpload(file))
  let skipped = files.length - uploadableFiles.length

  if (uploadableFiles.length === 0) {
    let errorMessage =
      files.length > 0 ? 'Only system files were selected.' : 'Select one or more files to send.'
    return redirectToUploadShare(request, token, { error: errorMessage })
  }

  let totalBytes = uploadableFiles.reduce((total, file) => total + file.size, 0)

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

  let destinationPrefix = share.targetDirectory ?? `share/${token}`
  await Promise.all(uploadableFiles.map((file) => saveFile(file, { prefix: destinationPrefix })))
  await registerUploadForToken(token, totalBytes)

  let updatedShare = findShare(token)
  let uploadSummary = `Uploaded ${uploadableFiles.length} file${
    uploadableFiles.length === 1 ? '' : 's'
  } (${formatBytes(totalBytes)}).`
  let skippedMessage =
    skipped > 0 ? ` Skipped ${skipped} hidden file${skipped === 1 ? '' : 's'}.` : ''

  if (!updatedShare || updatedShare.kind !== 'upload') {
    return uploadShareCompleted(
      `${uploadSummary}${skippedMessage} Upload link has reached its limit and is now closed.`,
    )
  }

  return redirectToUploadShare(request, token, {
    message: `${uploadSummary}${skippedMessage} Files delivered successfully.`,
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
