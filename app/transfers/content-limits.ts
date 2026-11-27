import { AppError } from '../contracts.ts'
import type { Metadata } from '../metadata.ts'

export const contentLimitFields = [
  {
    key: 'textPreviewKiB',
    label: 'Text preview and edit limit (KiB)',
    min: 1,
    max: 1024,
    initial: 256,
  },
  {
    key: 'inspectionKiB',
    label: 'Formatted text limit (KiB)',
    min: 1,
    max: 128,
    initial: 64,
  },
  {
    key: 'imageInputMiB',
    label: 'Image input limit (MiB)',
    min: 1,
    max: 16,
    initial: 16,
  },
  {
    key: 'imagePixels',
    label: 'Decoded image limit (pixels)',
    min: 1,
    max: 16_000_000,
    initial: 16_000_000,
  },
  {
    key: 'archivePreviewEntries',
    label: 'Archive preview limit (entries)',
    min: 1,
    max: 1000,
    initial: 1000,
  },
  {
    key: 'maxUploadBytes',
    label: 'Maximum size per upload (bytes)',
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    initial: 0,
  },
  {
    key: 'maxStagingBytes',
    label: 'Staging capacity per storage root (bytes)',
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    initial: 0,
  },
] as const

type Key = (typeof contentLimitFields)[number]['key']
export type ContentLimits = Readonly<Record<Key, number>>
export const defaultContentLimits: ContentLimits = Object.freeze(
  Object.fromEntries(
    contentLimitFields.map((field) => [field.key, field.initial]),
  ) as Record<Key, number>,
)

function applyLimits(current: ContentLimits, fields: Record<string, unknown>) {
  const next = { ...current }
  for (const { key, label, min, max } of contentLimitFields) {
    if (!Object.hasOwn(fields, key)) continue
    const raw = fields[key]
    const value =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && /^(0|[1-9][0-9]*)$/.test(raw)
          ? Number(raw)
          : NaN
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new AppError(
        400,
        label + ' must be a whole number from ' + min + ' to ' + max + '.',
      )
    next[key] = value
  }
  return Object.freeze(next)
}

export class ContentPolicy {
  private limits: ContentLimits
  constructor(private readonly metadata?: Pick<Metadata, 'value' | 'set'>) {
    const stored = metadata?.value('contentLimits', '{}') ?? '{}'
    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new AppError(500, 'Invalid stored preview and staging limits.')
    this.limits = applyLimits(
      defaultContentLimits,
      parsed as Record<string, unknown>,
    )
  }
  get current() {
    return this.limits
  }
  update(fields: Record<string, unknown>) {
    if (!contentLimitFields.some((field) => Object.hasOwn(fields, field.key)))
      throw new AppError(400, 'Provide a preview or staging limit.')
    const next = applyLimits(this.limits, fields)
    // A single row publishes the complete validated revision atomically.
    this.metadata?.set('contentLimits', JSON.stringify(next))
    this.limits = next
  }
}
