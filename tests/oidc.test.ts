import { beforeAll, expect, test } from 'bun:test'
import { Effect, Layer, Redacted, Schema } from 'effect'
import { SecureRandom, Signature } from 'effect/crypto'
import { Jwk, Jwt } from 'effect/jose'
import { TestClock } from 'effect/testing'
import { verifyIdentityProof } from '../app/identity/oidc.ts'

const library = Signature.layerWebCrypto.pipe(
  Layer.provide(SecureRandom.layerWebCrypto),
)
const schema = Schema.Struct({
  sub: Schema.String,
  iss: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  iat: Schema.Number,
  exp: Schema.optionalKey(Schema.Number),
  nonce: Schema.String,
  azp: Schema.optionalKey(Schema.String),
})
const seconds = 1_700_000_000
const expected = {
  issuer: 'https://issuer.example.test',
  clientId: 'local-app',
  subject: 'mapped',
  nonce: 'browser-session-nonce',
}
const regular = {
  sub: expected.subject,
  iss: expected.issuer,
  aud: expected.clientId,
  iat: seconds,
  exp: seconds + 300,
  nonce: expected.nonce,
}
let key: Jwk.PrivateKey
let keys: { keys: Jwk.PublicJwk[] }
let otherKeys: { keys: Jwk.PublicJwk[] }
beforeAll(async () => {
  const generate = () =>
    Effect.runPromise(
      Jwk.generateKeyPair({ algorithm: 'RS256', kid: 'primary' }).pipe(
        Effect.provide(library),
      ),
    )
  const [first, second] = await Promise.all([generate(), generate()])
  key = await Effect.runPromise(Jwk.importPrivate(first.privateKey, 'RS256'))
  keys = { keys: [first.publicKey] }
  otherKeys = { keys: [second.publicKey] }
})

function verify(claims: typeof schema.Type, keyset: unknown = keys) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make()
        yield* clock.setTime(seconds * 1000)
        const token = yield* Jwt.sign(schema, claims, key).pipe(
          Effect.provide(library),
        )
        return yield* Effect.promise(() =>
          verifyIdentityProof(
            Redacted.value(token),
            keyset,
            expected,
            clock,
            new AbortController().signal,
          ),
        )
      }),
    ),
  )
}

test('a verified issuer, subject, audience and browser nonce identify the local mapping', async () => {
  expect(await verify(regular)).toEqual({ sub: expected.subject })
  expect(
    await verify({
      ...regular,
      aud: [expected.clientId],
      azp: expected.clientId,
    }),
  ).toEqual({ sub: expected.subject })
})
test('identity proofs require the configured issuer key and valid time claims', async () => {
  await expect(verify(regular, otherKeys)).rejects.toThrow()
  await expect(verify(regular, { keys: [] })).rejects.toThrow()
  await expect(verify({ ...regular, exp: seconds })).rejects.toThrow()
  await expect(verify({ ...regular, iat: seconds - 601 })).rejects.toThrow()
  const { exp, ...missingExpiry } = regular
  expect(exp).toBeGreaterThan(seconds)
  await expect(verify(missingExpiry)).rejects.toThrow()
})
test('identity proofs bind the browser transaction, provider profile and registered client', async () => {
  for (const changed of [
    { iss: 'https://second-issuer.example.test' },
    { sub: 'different-account' },
    { aud: 'different-client' },
    { aud: [expected.clientId, 'different-client'] },
    { nonce: 'different-session' },
    { azp: 'different-party' },
  ])
    await expect(verify({ ...regular, ...changed })).rejects.toThrow()
})
