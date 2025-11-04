import * as path from 'node:path'
import type { BuildRouteHandler } from '@remix-run/fetch-router'
import { openFile } from '@remix-run/lazy-file/fs'

import { routes } from '../routes.ts'

const publicDir = path.join(import.meta.dirname, '..', 'public')
const publicAssetsDir = path.join(publicDir, 'assets')

export let assetsHandler: BuildRouteHandler<'GET', typeof routes.assets> = async ({ params }) => {
  return serveFile(path.join(publicAssetsDir, params.path))
}

function serveFile(filename: string): Response {
  try {
    let file = openFile(filename)
    let headers = new Headers({
      'Cache-Control': 'no-store, must-revalidate',
      'Content-Length': String(file.size),
    })

    if (file.type) {
      headers.set('Content-Type', file.type)
    }

    return new Response(file.stream(), { headers })
  } catch (error) {
    if (isNotFoundError(error)) {
      return new Response('Not found', { status: 404 })
    }

    throw error
  }
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException & { code: 'ENOENT' } {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
