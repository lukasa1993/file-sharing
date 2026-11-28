// Both profiles share the control API. Only the adapter chooses the byte transport.
function csrf() {
  const token = document.querySelector('meta[name=csrf-token]')?.content
  return token ? { 'X-CSRF-Token': token } : {}
}

async function control(path, method, data, signal) {
  const response = await fetch(path, {
    method,
    signal,
    headers: {
      ...csrf(),
      ...(data !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(data !== undefined && { body: JSON.stringify(data) }),
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
  })
  if (response.status === 204) return null
  const result = await response.json()
  if (!response.ok)
    throw new Error(
      (typeof result.error === 'string'
        ? result.error
        : result.error?.message) ||
        'Transfer failed (' + response.status + ').',
    )
  return result
}

async function sendParts(session, file, path, progress, signal) {
  if (!Number.isSafeInteger(session.partSize) || session.partSize < 1)
    throw new Error('Invalid part size.')
  const count = Math.max(1, Math.ceil(file.size / session.partSize))
  const parts = []
  for (let number = 1; number <= count; number++) {
    const start = (number - 1) * session.partSize
    const end = Math.min(file.size, start + session.partSize)
    const grant = await control(
      path + '/parts',
      'POST',
      { partNumber: number },
      signal,
    )
    const destination = new URL(grant.url)
    if (
      destination.origin === location.origin ||
      destination.username ||
      destination.password ||
      (destination.protocol !== 'https:' &&
        !(
          destination.protocol === 'http:' &&
          ['127.0.0.1', '[::1]'].includes(destination.hostname)
        ))
    )
      throw new Error('Invalid storage destination.')
    const result = await fetch(destination, {
      method: 'PUT',
      body: file.slice(start, end),
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    })
    if (!result.ok)
      throw new Error(
        'Storage rejected part ' + number + ' (' + result.status + ').',
      )
    const etag = result.headers.get('etag')
    if (!etag) throw new Error('Storage did not return a readable ETag.')
    parts.push({ partNumber: number, etag })
    progress(end, file.size)
  }
  return parts
}

async function sendTus(session, file, progress, signal) {
  const destination = new URL(session.url, location.href)
  if (
    destination.origin !== location.origin ||
    !Number.isSafeInteger(session.chunkSize) ||
    session.chunkSize < 1
  )
    throw new Error('Invalid self-hosted upload session.')
  for (let at = 0; at < file.size;) {
    const end = Math.min(file.size, at + session.chunkSize)
    const response = await fetch(destination, {
      method: 'PATCH',
      credentials: 'same-origin',
      redirect: 'error',
      signal,
      headers: {
        ...csrf(),
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': String(at),
        'Content-Type': 'application/offset+octet-stream',
      },
      body: file.slice(at, end),
    })
    if (!response.ok || response.headers.get('Upload-Offset') !== String(end))
      throw new Error('The server could not confirm the upload offset.')
    at = end
    progress(at, file.size)
  }
  return []
}

export async function uploadFile(file, options = {}) {
  const {
    signal,
    target,
    requestId,
    requestAlias = requestId,
    onProgress = () => {},
  } = options
  signal?.throwIfAborted()
  const base = '/api/transfers/uploads'
  // Finish obtaining the ID even if the user cancels mid-creation, so the reservation can be released.
  const session = await control(
    base,
    'POST',
    {
      name: file.name,
      size: file.size,
      idempotencyKey: crypto.randomUUID(),
      ...(target && { target }),
      ...(requestAlias && { requestAlias }),
    },
    AbortSignal.timeout(30000),
  )
  const path = base + '/' + encodeURIComponent(session.id)
  try {
    signal?.throwIfAborted()
    let parts
    if (session.transport === 'multipart')
      parts = await sendParts(session, file, path, onProgress, signal)
    else if (session.transport === 'tus')
      parts = await sendTus(session, file, onProgress, signal)
    else throw new Error('Unknown upload transport.')
    return await control(path + '/complete', 'POST', { parts }, signal)
  } catch (error) {
    await control(path, 'DELETE', undefined, AbortSignal.timeout(10000)).catch(
      () => undefined,
    )
    throw error
  }
}
