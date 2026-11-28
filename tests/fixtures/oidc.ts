import { createHash, randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect, Layer, Redacted, Schema } from 'effect'
import { SecureRandom, Signature } from 'effect/crypto'
import { Jwk, Jwt } from 'effect/jose'

const library = Signature.layerWebCrypto.pipe(
  Layer.provide(SecureRandom.layerWebCrypto),
)
const claims = Schema.Struct({
  iss: Schema.String,
  sub: Schema.String,
  aud: Schema.String,
  iat: Schema.Number,
  exp: Schema.Number,
  nonce: Schema.String,
})
const random = () => randomBytes(32).toString('base64url')
type Grant = {
  challenge: string
  state: string
  nonce: string
  subject: string
}
export async function fixtureIssuer(origin: string) {
  const clientId = 'fixture-app',
    clientSecret = random()
  const keys = await Effect.runPromise(
    Jwk.generateKeyPair({ algorithm: 'RS256', kid: 'fixture' }).pipe(
      Effect.provide(library),
    ),
  )
  const signingKey = await Effect.runPromise(
    Jwk.importPrivate(keys.privateKey, 'RS256'),
  )
  const redirectUri = origin + '/_/auth/oidc/callback'
  const pending = new Map<string, Grant>(),
    codes = new Map<string, Grant>(),
    access = new Map<string, string>()
  const denied = () => new Response(null, { status: 400 })
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request): Promise<Response> {
      const url = new URL(request.url),
        issuer = url.origin
      if (url.pathname === '/.well-known/openid-configuration')
        return Response.json({
          issuer,
          authorization_endpoint: issuer + '/authorize',
          token_endpoint: issuer + '/token',
          userinfo_endpoint: issuer + '/userinfo',
          jwks_uri: issuer + '/keys',
        })
      if (url.pathname === '/keys')
        return Response.json({ keys: [keys.publicKey] })
      if (url.pathname === '/authorize') {
        const p = url.searchParams,
          challenge = p.get('code_challenge'),
          state = p.get('state'),
          nonce = p.get('nonce')
        if (
          p.get('response_type') !== 'code' ||
          p.get('redirect_uri') !== redirectUri ||
          p.get('client_id') !== clientId ||
          p.get('code_challenge_method') !== 'S256' ||
          !state ||
          !nonce ||
          !challenge
        )
          return denied()
        const id = random()
        pending.set(id, { state, nonce, challenge, subject: '' })
        return new Response(
          `<!doctype html><html lang="en"><title>Fixture identity provider</title><h1>Choose a test account</h1>
        <form method="post" action="/choose"><input type="hidden" name="id" value="${id}">
        <button name="subject" value="operator">Mapped account</button>
        <button name="subject" value="visitor">Unmapped account</button></form></html>`,
          { headers: { 'Content-Type': 'text/html;charset=utf-8' } },
        )
      }
      if (url.pathname === '/choose' && request.method === 'POST') {
        const p = await request.formData(),
          id = String(p.get('id')),
          subject = String(p.get('subject'))
        const grant = pending.get(id)
        pending.delete(id)
        if (!grant || !['operator', 'visitor'].includes(subject))
          return denied()
        const code = random()
        codes.set(code, { ...grant, subject })
        const callback = new URL(redirectUri)
        callback.searchParams.set('code', code)
        callback.searchParams.set('state', grant.state)
        return Response.redirect(callback, 303)
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        const p = await request.formData(),
          code = String(p.get('code')),
          grant = codes.get(code)
        codes.delete(code)
        if (
          !grant ||
          p.get('grant_type') !== 'authorization_code' ||
          p.get('client_id') !== clientId ||
          p.get('client_secret') !== clientSecret ||
          p.get('redirect_uri') !== redirectUri ||
          createHash('sha256')
            .update(String(p.get('code_verifier')))
            .digest('base64url') !== grant.challenge
        )
          return denied()
        const seconds = Math.floor(Date.now() / 1000),
          token = random()
        const signed = await Effect.runPromise(
          Jwt.sign(
            claims,
            {
              iss: issuer,
              sub: grant.subject,
              aud: clientId,
              iat: seconds,
              exp: seconds + 300,
              nonce: grant.nonce,
            },
            signingKey,
          ).pipe(Effect.provide(library)),
        )
        access.set(token, grant.subject)
        return Response.json({
          access_token: token,
          token_type: 'Bearer',
          id_token: Redacted.value(signed),
        })
      }
      if (url.pathname === '/userinfo') {
        const subject = access.get(
          (request.headers.get('authorization') ?? '').slice(7),
        )
        // Both subjects deliberately share display claims. Authorization must depend on the verified sub.
        return subject
          ? Response.json({
              sub: subject,
              email: 'fixture-owner@example.test',
              email_verified: true,
            })
          : denied()
      }
      return new Response(null, { status: 404 })
    },
  })
  return {
    issuer: server.url.origin,
    clientId,
    clientSecret,
    close: () => server.stop(true),
  }
}

export async function configureFixtureIssuer(
  directory: string,
  origin: string,
  username: string,
) {
  const idp = await fixtureIssuer(origin)
  try {
    const secretFile = join(directory, 'oidc.secret'),
      mountFile = join(directory, 'mounts.json')
    await writeFile(secretFile, idp.clientSecret, { mode: 0o600 })
    const config = JSON.parse(await readFile(mountFile, 'utf8'))
    config.oidc = {
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecretFile: secretFile,
      accounts: [{ subject: 'operator', username }],
    }
    await writeFile(mountFile, JSON.stringify(config))
    return idp
  } catch (error) {
    await idp.close()
    throw error
  }
}
