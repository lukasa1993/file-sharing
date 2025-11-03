export function parsePositiveInteger(value: FormDataEntryValue | null | undefined) {
  if (typeof value !== 'string') return undefined
  let parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

export function parseNonNegativeInteger(value: FormDataEntryValue | null | undefined) {
  if (typeof value !== 'string') return undefined
  let parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return parsed
}

const byteUnitMultipliers = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  tb: 1024 * 1024 * 1024 * 1024,
} as const

export type ByteUnit = keyof typeof byteUnitMultipliers

export function parseByteLimit(
  value: FormDataEntryValue | null | undefined,
  unit: FormDataEntryValue | null | undefined,
) {
  if (typeof value !== 'string') return undefined
  let trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  let numeric = Number.parseFloat(trimmed)
  if (!Number.isFinite(numeric) || numeric < 0) return undefined
  let resolvedUnit: ByteUnit = 'b'
  if (typeof unit === 'string' && unit in byteUnitMultipliers) {
    resolvedUnit = unit as ByteUnit
  }
  if (numeric === 0) return 0
  let multiplier = byteUnitMultipliers[resolvedUnit]
  let bytes = Math.round(numeric * multiplier)
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined
  return bytes
}
