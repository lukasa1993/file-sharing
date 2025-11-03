import type { RequestContext } from '@remix-run/fetch-router'

export async function readContextFormData(context: RequestContext) {
  if (context.formData instanceof FormData) {
    return context.formData
  }

  return await context.request.formData()
}
