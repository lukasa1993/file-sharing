import { router } from './app/router.ts'
import { applySecurityHeaders } from './app/utils/security-headers.ts'

let port = Number.parseInt(Bun.env.PORT ?? '', 10)
if (!Number.isFinite(port)) {
  port = 44100
}

let server = Bun.serve({
  port,
  fetch: async (request: Request) => {
    try {
      let response = await router.fetch(request)
      return applySecurityHeaders(response)
    } catch (error) {
      console.error(error)
      return applySecurityHeaders(new Response('Internal Server Error', { status: 500 }))
    }
  },
  error(error: unknown) {
    console.error(error)
    return applySecurityHeaders(new Response('Internal Server Error', { status: 500 }))
  },
})

console.log(`File sharing demo running on http://localhost:${server.port}`)
console.log('Visit /admin to manage files and generate share links.')
