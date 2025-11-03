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
