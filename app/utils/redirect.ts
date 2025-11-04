type RedirectOptions = {
  status?: number
  params?: Record<string, string | undefined>
  hash?: string
}

export function redirectWithSearch(request: Request, to: string, options: RedirectOptions = {}) {
  let location = new URL(to, request.url)
  if (options.params) {
    for (let [key, value] of Object.entries(options.params)) {
      if (value != null && value !== '') {
        location.searchParams.set(key, value)
      }
    }
  }
  if (options.hash) {
    location.hash = options.hash
  }

  let status = options.status ?? 303
  return Response.redirect(location.toString(), status)
}

export function resolveSafeRedirect(
  request: Request,
  target: string | null | undefined,
  fallback: string,
) {
  if (typeof target !== 'string') {
    return fallback
  }

  let trimmed = target.trim()
  if (trimmed.length === 0) {
    return fallback
  }

  try {
    let requestUrl = new URL(request.url)
    let resolved = new URL(trimmed, requestUrl)
    if (resolved.origin !== requestUrl.origin) {
      return fallback
    }
    if (!resolved.pathname.startsWith('/')) {
      return fallback
    }
    return `${resolved.pathname}${resolved.search}${resolved.hash}`
  } catch {
    return fallback
  }
}
