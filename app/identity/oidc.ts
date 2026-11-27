import { Clock, Effect, Layer, Schema } from 'effect'
import { SecureRandom, Signature } from 'effect/crypto'
import { Jwks, Jwt } from 'effect/jose'
import { createOIDCAuthProvider } from 'remix/auth'
import { object, parseSafe, string } from 'remix/data-schema'
import { AppError, type OidcConfig } from '../contracts.ts'
import { runTask } from '../effects.ts'

export const oidcCallbackPath = '/_/auth/oidc/callback'
const metadataSchema = object({
  issuer: string(),
  authorization_endpoint: string(),
  token_endpoint: string(),
  userinfo_endpoint: string(),
  jwks_uri: string(),
})
const claimsSchema = Schema.Struct({
  sub: Schema.String,
  nonce: Schema.String,
  azp: Schema.optionalKey(Schema.String),
})
const signature = Signature.layerWebCrypto.pipe(
  Layer.provide(SecureRandom.layerWebCrypto),
)

async function boundedJson(url: URL, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error('Provider unavailable')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 128 * 1024) {
        await reader.cancel()
        throw new Error('Provider response exceeds the allowed size')
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

type ExpectedIdentity = Pick<OidcConfig, 'issuer' | 'clientId'> & {
  nonce: string
  subject: string
}

export async function verifyIdentityProof(
  token: string,
  keys: unknown,
  expected: ExpectedIdentity,
  clock: Clock.Clock,
  signal: AbortSignal,
) {
  const set = await runTask(Schema.decodeUnknownEffect(Jwks.KeySet)(keys), {
    signal,
  })
  if (!set.keys.length || set.keys.length > 64)
    throw new Error('Invalid key set')
  const proof = await runTask(
    Jwt.verifyWithKeySet(claimsSchema, token, {
      algorithms: ['RS256'],
      issuer: expected.issuer,
      audience: expected.clientId,
      subject: expected.subject,
      requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp'],
      maxTokenAge: '10 minutes',
    }).pipe(
      Effect.provideService(Clock.Clock, clock),
      Effect.provide(Layer.merge(Jwks.layerLocal(set), signature)),
    ),
    { signal },
  )
  const audience = proof.registeredClaims.aud
  if (
    proof.claims.nonce !== expected.nonce ||
    (proof.claims.azp !== undefined &&
      proof.claims.azp !== expected.clientId) ||
    (Array.isArray(audience) && audience.some((id) => id !== expected.clientId))
  )
    throw new Error('Invalid identity proof')
  return { sub: proof.claims.sub }
}

export class OidcProvider {
  constructor(
    private readonly config: OidcConfig,
    private readonly origin: string,
    private readonly clock: Clock.Clock,
  ) {}

  async provider(nonce: string, signal: AbortSignal) {
    const { issuer, clientId, clientSecret } = this.config
    const base = new URL(issuer)
    const discovered = await boundedJson(
      new URL(issuer.replace(/\/$/, '') + '/.well-known/openid-configuration'),
      signal,
    )
    const parsed = parseSafe(metadataSchema, discovered)
    if (!parsed.success || parsed.value.issuer !== issuer)
      throw new AppError(503, 'Identity provider unavailable.')
    const metadata = parsed.value
    for (const target of [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.userinfo_endpoint,
      metadata.jwks_uri,
    ]) {
      const endpoint = new URL(target)
      if (
        endpoint.username ||
        endpoint.password ||
        endpoint.hash ||
        !(
          endpoint.protocol === 'https:' ||
          (base.protocol === 'http:' && base.origin === endpoint.origin)
        )
      )
        throw new AppError(503, 'Invalid identity provider endpoint.')
    }
    return createOIDCAuthProvider({
      issuer,
      clientId,
      clientSecret,
      metadata,
      redirectUri: new URL(oidcCallbackPath, this.origin),
      scopes: ['openid'],
      authorizationParams: { nonce },
      mapProfile: async ({ claims, tokens }) => {
        const token = tokens.idToken
        if (!token || token.length > 16384)
          throw new Error('Missing identity proof')
        const keys = await boundedJson(new URL(metadata.jwks_uri), signal)
        return verifyIdentityProof(
          token,
          keys,
          { issuer, clientId, nonce, subject: claims.sub },
          this.clock,
          signal,
        )
      },
    })
  }
}
