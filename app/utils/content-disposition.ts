export function attachmentDisposition(filename: string) {
  let safeName = filename.replace(/"/g, '')
  return `attachment; filename="${safeName}"; filename*=UTF-8''${encodeRFC5987ValueChars(filename)}`
}

function encodeRFC5987ValueChars(str: string) {
  return encodeURIComponent(str)
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A')
    .replace(/%(?:7C|60|5E)/g, unescape)
}
