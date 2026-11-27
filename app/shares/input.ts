import * as S from 'remix/data-schema'
import { AppError } from '../contracts.ts'

const nullableLimit = S.optional(S.nullable(S.number()))
const schema = S.object(
  {
    alias: S.optional(S.string()),
    ownerId: S.optional(S.string()),
    kind: S.optional(S.enum_(['download', 'upload'])),
    access: S.optional(S.enum_(['public', 'authenticated', 'password'])),
    mode: S.optional(S.enum_(['direct', 'landing'])),
    targets: S.optional(
      S.array(
        S.object(
          {
            mountId: S.string(),
            segments: S.array(S.string()),
          },
          { unknownKeys: 'error' },
        ),
      ),
    ),
    enabled: S.optional(S.boolean()),
    latestAtPath: S.optional(S.boolean()),
    confirmPublic: S.optional(S.boolean()),
    expiresAt: S.optional(S.nullable(S.string())),
    maxBytes: nullableLimit,
    maxDownloads: nullableLimit,
    bytesPerSecond: nullableLimit,
    password: S.optional(S.string()),
  },
  { unknownKeys: 'error' },
)

export function parseShareInput(input: unknown) {
  const result = S.parseSafe(schema, input)
  if (!result.success) throw new AppError(400, 'Invalid share options.')
  return result.value
}

export type ShareInput = ReturnType<typeof parseShareInput>

const batchSchema = S.object(
  {
    operation: S.enum_(['disable', 'revoke']),
    ids: S.array(S.string()),
  },
  { unknownKeys: 'error' },
)

export function parseBatch(value: unknown) {
  const parsed = S.parseSafe(batchSchema, value)
  if (
    !parsed.success ||
    !parsed.value.ids.length ||
    parsed.value.ids.length > 100
  )
    throw new AppError(400, 'Choose between one and 100 sharing links.')
  return { ...parsed.value, ids: [...new Set(parsed.value.ids)] }
}
