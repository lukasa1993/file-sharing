export function attachmentDisposition(filename: string) {
  let sanitized = sanitizeFilename(filename)
  let quotedName = sanitized.replace(/"/g, '')
  return `attachment; filename="${quotedName}"; filename*=UTF-8''${encodeRFC5987ValueChars(sanitized)}`
}

function encodeRFC5987ValueChars(str: string) {
  return encodeURIComponent(str)
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A')
    .replace(/%(?:7C|60|5E)/g, unescape)
}

function sanitizeFilename(input: string) {
  let withoutControl = input.replace(/[\r\n]+/g, ' ').trim()
  if (withoutControl.length === 0) {
    return 'download'
  }
  return withoutControl
}
