import { extname } from 'node:path'
import { Effect } from 'effect'
import { AppError, type Guard, type ResourceRef } from '../contracts.ts'
import { attempt, runTask } from '../effects.ts'
import type { Filesystem } from '../filesystem/index.ts'
import { version } from '../filesystem/resolver.ts'
import { readBounded } from '../transfers/streams.ts'
import {
  inspectionDocument,
  renderItems,
  renderMarkdown,
  renderSource,
} from './render.ts'
import { listTarHeaders, UnsupportedInspection } from './tar.ts'

const readLimit = 64 * 1024
const plain = new Set(['.txt', '.log', '.csv', '.yaml', '.yml', '.toml'])
const source = new Set([
  '.ts',
  '.tsx',
  '.css',
  '.py',
  '.go',
  '.rs',
  '.sql',
  '.json',
])
const markdown = new Set(['.md', '.markdown'])

/** Produce a sandboxed document from an authorized open handle, within fixed work and output bounds. */
export async function inspectFile(
  request: Request,
  ref: ResourceRef,
  guard: Guard,
  fs: Pick<Filesystem, 'openReadScoped'>,
) {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "sandbox allow-downloads; default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  }
  const task = Effect.scoped(
    Effect.gen(function* () {
      const { entry, handle } = yield* fs.openReadScoped(ref, guard)
      return yield* attempt(async () => {
        const ext = extname(entry.name).toLowerCase()
        const query = new URLSearchParams({
          mount: ref.mountId,
          path: ref.segments.join('/'),
        })
        const link = '/_/download?' + query
        let content: string,
          note: string | undefined,
          status = 200
        try {
          if (ext === '.tar')
            content = renderItems(
              await listTarHeaders(handle, entry.size, request.signal),
            )
          else if (markdown.has(ext) || source.has(ext) || plain.has(ext)) {
            const bytes = await readBounded(
              handle,
              Math.min(entry.size, readLimit),
            )
            const truncated = entry.size > readLimit
            let text: string
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, {
                stream: truncated,
              })
            } catch {
              throw new UnsupportedInspection(
                'This file is outside the supported UTF-8 text formats.',
              )
            }
            if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
              throw new UnsupportedInspection('This file contains binary data.')
            content = markdown.has(ext)
              ? renderMarkdown(text)
              : renderSource(text, source.has(ext))
            if (truncated) note = 'Preview limited to the first 64 KiB.'
          } else
            throw new UnsupportedInspection(
              'This format is available as a download.',
            )
        } catch (error) {
          if (!(error instanceof UnsupportedInspection)) throw error
          content = ''
          note = error.message
          status = 415
        }
        request.signal.throwIfAborted()
        guard('read', ref)
        const stat = await handle.stat({ bigint: true })
        if (version(stat) !== entry.version)
          throw new AppError(
            409,
            'This file changed while its preview was being prepared.',
          )
        return new Response(
          request.method === 'HEAD'
            ? null
            : inspectionDocument(entry.name, content, link, note),
          { status, headers },
        )
      })
    }),
  )
  return runTask(task, { signal: request.signal })
}
