export function parsePositiveInteger(value: FormDataEntryValue | null | undefined) {
  if (typeof value !== 'string') return undefined
  let parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}
