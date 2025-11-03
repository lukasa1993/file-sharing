import type { Middleware, RequestContext } from '@remix-run/fetch-router'
import { createStorageKey } from '@remix-run/fetch-router'

export const requestContextKey = createStorageKey<RequestContext>()

export function storeContext(): Middleware {
  return async (context, next) => {
    context.storage.set(requestContextKey, context)
    return next()
  }
}
