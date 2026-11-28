import { AppError, type ResourceRef } from '../contracts.ts'
import { resource } from '../metadata.ts'

export function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}
export function decode(id: string): unknown {
  try {
    const bytes = Buffer.from(id, 'base64url')
    if (!id || bytes.toString('base64url') !== id)
      throw new Error('Invalid base64')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new AppError(404, 'Unknown transfer resource.')
  }
}
export function fileRef(id: string) {
  if (!id.startsWith('f_')) throw new AppError(404, 'Unknown file.')
  const ref = resource(decode(id.slice(2)))
  if (!ref.segments.length) throw new AppError(404, 'Unknown file.')
  return ref
}
export function fileId(ref: ResourceRef) {
  return 'f_' + encode(ref)
}
