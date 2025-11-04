import { config } from '../config.ts'

let scriptSrc = ["'self'", 'https://cdn.jsdelivr.net']

let styleSrc = ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net']
let connectSrc = ["'self'"]
let imgSrc = ["'self'", 'data:', 'blob:']
let fontSrc = ["'self'", 'data:']

let cspDirectives = [
  "default-src 'self'",
  `script-src ${scriptSrc.join(' ')}`,
  `style-src ${styleSrc.join(' ')}`,
  `connect-src ${connectSrc.join(' ')}`,
  `img-src ${imgSrc.join(' ')}`,
  `font-src ${fontSrc.join(' ')}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ')

const SECURITY_HEADERS: Array<[string, string]> = [
  ['Content-Security-Policy', cspDirectives],
  ['Referrer-Policy', 'no-referrer'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
  ['X-Frame-Options', 'DENY'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
  ['X-DNS-Prefetch-Control', 'off'],
]

export function applySecurityHeaders(response: Response) {
  for (let [name, value] of SECURITY_HEADERS) {
    if (!response.headers.has(name)) {
      response.headers.set(name, value)
    }
  }

  if (config.secureCookies) {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }

  return response
}
