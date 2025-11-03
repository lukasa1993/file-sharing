import { createHmac, timingSafeEqual } from 'node:crypto'
import { Cookie, SetCookie } from '@remix-run/headers'

import { config } from '../config.ts'

export const SESSION_COOKIE = 'fs_session'

type SessionPayload = {
  username: string
  expiresAt: number
}

export type SessionData = {
  username: string
}

const secretBuffer = Buffer.from(config.sessionSecret, 'utf8')

export function createSessionCookie(username: string) {
  let expiresAt = Date.now() + config.sessionMaxAgeSeconds * 1000
  let token = signPayload({ username, expiresAt })

  let cookie = new SetCookie({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: config.sessionMaxAgeSeconds,
    secure: config.secureCookies ? true : undefined,
  })

  return cookie.toString()
}

export function clearSessionCookie() {
  let cookie = new SetCookie({
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: 0,
    expires: new Date(0),
    secure: config.secureCookies ? true : undefined,
  })

  return cookie.toString()
}

export function getSessionFromRequest(request: Request): SessionData | null {
  let cookieHeader = request.headers.get('cookie')
  if (!cookieHeader) return null

  let cookie = new Cookie(cookieHeader)
  let value = cookie.get(SESSION_COOKIE)
  if (!value) return null

  let payload = verifyPayload(value)
  if (!payload) return null
  if (payload.expiresAt <= Date.now()) return null

  return { username: payload.username }
}

function signPayload(payload: SessionPayload) {
  let data = Buffer.from(JSON.stringify(payload)).toString('base64url')
  let signature = createHmac('sha256', secretBuffer).update(data).digest('base64url')
  return `${data}.${signature}`
}

function verifyPayload(token: string): SessionPayload | null {
  let [data, signature] = token.split('.')
  if (!data || !signature) return null

  let expected = createHmac('sha256', secretBuffer).update(data).digest()
  let provided: Buffer
  try {
    provided = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }

  if (expected.length !== provided.length) {
    return null
  }

  if (!timingSafeEqual(expected, provided)) {
    return null
  }

  try {
    let payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as SessionPayload
    if (typeof payload.username !== 'string' || typeof payload.expiresAt !== 'number') {
      return null
    }
    return payload
  } catch {
    return null
  }
}
