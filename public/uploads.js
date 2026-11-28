// Upload bytes in bounded chunks. A stored digest for each attempted chunk lets a
// reselected file prove that every byte already accepted belongs to that file.
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024
const PARALLEL = 3
const jobs = new Map()
const finishedStates = new Set(['Completed', 'Skipped', 'Cancelled'])
let loadedScope = ''
let stateStore
let uploadNotice = () => {}

function database() {
  return (stateStore ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('fileserver-uploads', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('jobs', { keyPath: 'id' })
      const digests = request.result.createObjectStore('digests', {
        keyPath: ['id', 'offset'],
      })
      digests.createIndex('job', 'id')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }))
}
async function write(store, fn) {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    fn(tx.objectStore(store))
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
    tx.onabort = () =>
      reject(tx.error || new Error('Transfer storage is unavailable'))
  })
}
async function read(store, key) {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store)
    const r =
      key === undefined
        ? tx.objectStore(store).getAll()
        : tx.objectStore(store).get(key)
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}
function meta(job) {
  const {
    id,
    scope,
    createUrl,
    location,
    filename,
    relative,
    size,
    lastModified,
    mount,
    parent,
    offset,
    conflict,
    chunkBytes,
  } = job
  return {
    id,
    scope,
    createUrl,
    location,
    filename,
    relative,
    size,
    lastModified,
    mount,
    parent,
    offset,
    conflict,
    chunkBytes,
  }
}
async function save(job) {
  await write('jobs', (store) => store.put(meta(job)))
}
async function forget(id) {
  await write('jobs', (store) => store.delete(id))
  await write('digests', (store) =>
    store.delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])),
  )
}
function toBase64(value) {
  const bytes = new TextEncoder().encode(value)
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
}
function headers(extra = {}) {
  return {
    'Tus-Resumable': '1.0.0',
    'X-CSRF-Token':
      document.querySelector('meta[name=csrf-token]')?.content || '',
    ...extra,
  }
}
function fileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB'
  return (bytes / 1073741824).toFixed(2) + ' GB'
}
async function error(response) {
  const fallback = 'Transfer failed (HTTP ' + response.status + ').'
  const type = response.headers.get('Content-Type')?.split(';')[0]
  if (type === 'text/plain')
    return new Error((await response.text()).trim() || fallback)
  if (type === 'application/json') {
    try {
      const body = await response.json()
      return new Error(body.error?.message || body.message || fallback)
    } catch {
      return new Error(fallback)
    }
  }
  return new Error(fallback)
}
function chunkLimit(response, previous) {
  const header = response.headers.get('Fileserver-Max-Chunk-Bytes')
  const advertised = header && /^\d+$/.test(header) ? Number(header) : 0
  const fallback =
    Number.isSafeInteger(previous) && previous > 0
      ? previous
      : DEFAULT_CHUNK_BYTES
  return Math.min(
    DEFAULT_CHUNK_BYTES,
    Number.isSafeInteger(advertised) && advertised > 0 ? advertised : fallback,
  )
}
async function offsetAtServer(job, signal) {
  const r = await fetch(job.location, {
    method: 'HEAD',
    headers: headers(),
    signal,
    cache: 'no-store',
  })
  if (!r.ok) throw await error(r)
  const value = r.headers.get('Upload-Offset'),
    offset = Number(value)
  if (
    value === null ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > job.size
  )
    throw new Error('The server returned an invalid upload offset.')
  job.chunkBytes = chunkLimit(r, job.chunkBytes)
  return { offset, skipped: r.headers.get('Upload-State') === 'skipped' }
}
async function digest(bytes) {
  const data = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(data, (v) => v.toString(16).padStart(2, '0')).join('')
}
async function verifyPrefix(job, offset, signal) {
  for (let at = 0; at < offset;) {
    signal.throwIfAborted()
    const record = await read('digests', [job.id, at])
    if (!record || record.end > offset || record.end <= at)
      throw new Error(
        'The accepted bytes cannot be verified. Cancel this upload and start again.',
      )
    const bytes = await job.file.slice(at, record.end).arrayBuffer()
    if ((await digest(bytes)) !== record.hash)
      throw new Error(
        'This file differs from the original. Choose the original file or start a new upload.',
      )
    at = record.end
  }
}
function checkedSameOrigin(location) {
  const url = new URL(location, window.location.href)
  if (url.origin !== window.location.origin)
    throw new Error('The server returned an invalid upload location.')
  return url.pathname + url.search
}
async function upload(job) {
  const controller = new AbortController()
  job.controller = controller
  job.state = 'Uploading'
  job.error = ''
  job.rate = 0
  const signal = controller.signal
  let completed = false
  let skipped = false
  try {
    if (!job.location) {
      const parts = job.relative.split('/')
      parts.pop()
      const fields = {
        filename: job.filename,
        path: [...job.parent, ...parts].join('/'),
      }
      if (job.mount) {
        fields.mount = job.mount
        fields.conflict = job.conflict || 'reject'
      }
      const r = await fetch(job.createUrl, {
        method: 'POST',
        // Recover the server's Location even if a user pauses during creation.
        // Cancellation can then terminate the reservation before dismissing it.
        signal: AbortSignal.timeout(30000),
        headers: headers({
          'Upload-Length': String(job.size),
          'Upload-Metadata': Object.entries(fields)
            .filter(([, v]) => v !== '')
            .map(([k, v]) => k + ' ' + toBase64(v))
            .join(','),
        }),
      })
      if (!r.ok) throw await error(r)
      const loc = r.headers.get('Location')
      if (!loc) throw new Error('The server did not return an upload location.')
      skipped = r.headers.get('Upload-State') === 'skipped'
      job.location = checkedSameOrigin(loc)
      job.chunkBytes = chunkLimit(r)
      await save(job)
      job.offset = 0
    } else {
      const status = await offsetAtServer(job, signal)
      job.offset = status.offset
      skipped = status.skipped
      if (job.verify) {
        job.state = 'Verifying'
        renderTransfers()
        await verifyPrefix(job, job.offset, signal)
        job.verify = false
        job.state = 'Uploading'
      }
    }
    let started = performance.now(),
      startOffset = job.offset
    while (job.offset < job.size) {
      signal.throwIfAborted()
      const at = job.offset,
        end = Math.min(job.size, at + job.chunkBytes)
      const bytes = await job.file.slice(at, end).arrayBuffer()
      const hash = await digest(bytes)
      await write('digests', (s) =>
        s.put({ id: job.id, offset: at, end, hash }),
      )
      const r = await fetch(job.location, {
        method: 'PATCH',
        signal,
        headers: headers({
          'Content-Type': 'application/offset+octet-stream',
          'Upload-Offset': String(at),
        }),
        body: bytes,
      })
      if (!r.ok) throw await error(r)
      if (r.headers.get('Upload-Offset') !== String(end))
        throw new Error(
          'The server did not confirm this chunk. Retry to check its offset.',
        )
      skipped = r.headers.get('Upload-State') === 'skipped'
      job.offset = end
      job.rate =
        (end - startOffset) /
        Math.max((performance.now() - started) / 1000, 0.001)
      await save(job)
      renderTransfers()
    }
    completed = true
    job.state = skipped ? 'Skipped' : 'Completed'
    job.file = null
    job.error = ''
    await forget(job.id)
    if (!skipped)
      window.dispatchEvent(
        new CustomEvent('transfer-complete', { detail: meta(job) }),
      )
  } catch (e) {
    if (!completed && !signal.aborted) {
      job.state = 'Failed'
      job.error = e.message || 'Transfer interrupted'
    }
  } finally {
    job.controller = null
    renderTransfers()
    pump()
  }
}
function pump() {
  let available =
    PARALLEL - [...jobs.values()].filter((j) => j.controller).length
  for (const job of jobs.values()) {
    if (available <= 0) break
    if (
      job.state !== 'Queued' ||
      job.scope !== loadedScope ||
      !job.file ||
      job.controller
    )
      continue
    available--
    job.running = upload(job)
    safely(job.running)
  }
  renderTransfers()
}
function ownerScope() {
  const id = document.querySelector('[data-account]')?.dataset.account
  const share = document.querySelector('[data-share-id]')?.dataset.shareId
  return id ? 'owner:' + id : share ? 'share:' + share : ''
}
export async function initUploads(notice) {
  document.querySelectorAll('[data-upload-directory]').forEach((input) => {
    input.webkitdirectory = true
  })
  uploadNotice = notice
  const scope = ownerScope()
  if (scope !== loadedScope) {
    loadedScope = scope
    if (scope) {
      try {
        const stored = await read('jobs')
        for (const job of stored)
          if (job.scope === scope && !jobs.has(job.id))
            jobs.set(job.id, {
              ...job,
              file: null,
              controller: null,
              state: 'Choose file to resume',
              verify: true,
            })
      } catch {
        uploadNotice(
          'This browser could not open persistent upload storage.',
          true,
        )
      }
    }
  }
  const choice = document.querySelector('[data-upload-conflict]')
  if (choice)
    try {
      choice.value =
        sessionStorage.getItem('fileserver:upload-conflict:' + loadedScope) ||
        'reject'
    } catch {
      choice.value = 'reject'
    }
  renderTransfers()
}
function el(tag, content, cls) {
  const node = document.createElement(tag)
  if (content) node.textContent = content
  if (cls) node.className = cls
  return node
}
export function renderTransfers() {
  const visible = [...jobs.values()].filter((j) => j.scope === loadedScope)
  const active = visible.filter((j) => !finishedStates.has(j.state))
  document.querySelectorAll('[data-queue-count]').forEach((count) => {
    count.hidden = active.length === 0
    count.textContent = String(active.length)
  })
  document.querySelectorAll('[data-transfer-list]').forEach((list) => {
    list.replaceChildren()
    if (visible.length === 0 && !list.classList.contains('inline-transfers'))
      list.append(el('p', 'No transfers in this session.', 'quiet'))
    if (active.length > 1) {
      const total = active.reduce((sum, j) => sum + j.size, 0),
        done = active.reduce((sum, j) => sum + j.offset, 0)
      list.append(
        el(
          'p',
          fileSize(done) +
            ' of ' +
            fileSize(total) +
            ' across ' +
            active.length +
            ' transfers',
          'quiet',
        ),
      )
    }
    for (const job of visible.slice().reverse()) {
      const row = el('div', '', 'transfer-item'),
        progress = el('progress')
      row.setAttribute('role', 'group')
      row.setAttribute('aria-label', job.relative)
      progress.max = job.size || 1
      progress.value = job.state === 'Completed' ? progress.max : job.offset
      progress.setAttribute('aria-label', job.filename + ' progress')
      let status =
        job.state + ' · ' + fileSize(job.offset) + ' of ' + fileSize(job.size)
      if (job.state === 'Uploading' && job.rate > 0)
        status +=
          ' · ' +
          fileSize(job.rate) +
          '/s · ' +
          Math.ceil((job.size - job.offset) / job.rate) +
          's remaining'
      row.append(el('strong', job.relative), el('small', status), progress)
      if (job.error) {
        const err = el('p', job.error)
        err.setAttribute('role', 'alert')
        row.append(err)
      }
      const controls = el('div')
      function button(action, label) {
        const b = el('button', label)
        b.type = 'button'
        b.dataset.uploadTask = job.id
        b.dataset.uploadAction = action
        controls.append(b)
      }
      if (
        job.state === 'Uploading' ||
        job.state === 'Queued' ||
        job.state === 'Verifying'
      )
        button('pause', 'Pause')
      if (['Paused', 'Failed', 'Choose file to resume'].includes(job.state))
        button(
          'resume',
          job.file && !job.verify ? 'Retry / resume' : 'Choose file to resume',
        )
      if (finishedStates.has(job.state)) button('remove', 'Dismiss')
      else if (job.state !== 'Cancelling') button('cancel', 'Cancel')
      row.append(controls)
      list.append(row)
    }
  })
}
async function start(files) {
  const target = document.querySelector('[data-upload-url]')
  if (!target?.dataset.uploadUrl || !loadedScope) return
  const ref = target.dataset.ref
    ? JSON.parse(target.dataset.ref)
    : { mountId: '', segments: [] }
  for (const item of files) {
    const file = item.file,
      relative = item.path || file.webkitRelativePath || file.name
    const job = {
      id: crypto.randomUUID(),
      scope: loadedScope,
      mount: ref.mountId,
      parent: ref.segments,
      relative,
      filename: file.name,
      file,
      size: file.size,
      lastModified: file.lastModified,
      offset: 0,
      location: '',
      createUrl: target.dataset.uploadUrl,
      conflict:
        document.querySelector('[data-upload-conflict]')?.value || 'reject',
      state: 'Queued',
      controller: null,
      verify: false,
    }
    await save(job)
    jobs.set(job.id, job)
  }
  if (
    files.length &&
    document.querySelector('#transfers') &&
    !document.querySelector('#transfers').open
  )
    document.querySelector('#transfers').showModal()
  pump()
}
function safely(work) {
  Promise.resolve(work).catch((e) =>
    uploadNotice(e.message || 'Upload failed', true),
  )
}
async function drop(items) {
  const files = []
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej))
      files.push({ file, path: prefix + file.name })
      return
    }
    if (!entry.isDirectory) return
    const reader = entry.createReader()
    for (;;) {
      const chunk = await new Promise((res, rej) =>
        reader.readEntries(res, rej),
      )
      if (!chunk.length) break
      for (const child of chunk) await walk(child, prefix + entry.name + '/')
    }
  }
  for (const item of items) {
    if (item.entry) await walk(item.entry, '')
    else if (item.file) files.push({ file: item.file })
  }
  await start(files)
}
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-upload-conflict]')) {
    if (
      e.target.value === 'overwrite' &&
      !window.confirm(
        'Replace existing files when a new upload has the same name?',
      )
    )
      e.target.value = 'reject'
    try {
      sessionStorage.setItem(
        'fileserver:upload-conflict:' + loadedScope,
        e.target.value,
      )
    } catch {
      uploadNotice('This upload setting applies to the current page only.')
    }
  }
  if (e.target.matches('[data-upload-files],[data-upload-directory]')) {
    const files = [...e.target.files].map((file) => ({ file }))
    e.target.value = ''
    safely(start(files))
  }
})
document.addEventListener('click', (e) => {
  const target = e.target.closest('button')
  if (!target) return
  if (target.hasAttribute('data-upload-button'))
    document.querySelector('[data-upload-files]')?.click()
  if (target.hasAttribute('data-folder-upload-button'))
    document.querySelector('[data-upload-directory]')?.click()
  if (!target.dataset.uploadTask) return
  const job = jobs.get(target.dataset.uploadTask)
  if (!job || job.scope !== loadedScope) return
  const action = target.dataset.uploadAction
  if (action === 'pause') {
    job.state = 'Paused'
    job.controller?.abort()
    renderTransfers()
  }
  if (action === 'remove') {
    jobs.delete(job.id)
    renderTransfers()
  }
  if (action === 'resume') {
    if (job.file && !job.verify) {
      job.state = 'Queued'
      pump()
      return
    }
    const picker = el('input')
    picker.type = 'file'
    picker.addEventListener('change', () => {
      const file = picker.files?.[0]
      if (!file) return
      if (
        file.name !== job.filename ||
        file.size !== job.size ||
        (job.lastModified !== undefined &&
          file.lastModified !== job.lastModified)
      ) {
        uploadNotice('Choose the original file to resume.', true)
        return
      }
      job.file = file
      job.verify = true
      job.state = 'Queued'
      pump()
    })
    picker.click()
  }
  if (action === 'cancel')
    safely(
      (async () => {
        job.state = 'Cancelling'
        job.controller?.abort()
        renderTransfers()
        try {
          await job.running
          if (finishedStates.has(job.state)) return
          if (job.location) {
            const r = await fetch(job.location, {
              method: 'DELETE',
              headers: headers(),
            })
            if (r.status === 409) {
              const status = await offsetAtServer(job)
              if (status.offset !== job.size) throw await error(r)
              job.offset = status.offset
              job.state = status.skipped ? 'Skipped' : 'Completed'
              if (!status.skipped)
                window.dispatchEvent(
                  new CustomEvent('transfer-complete', { detail: meta(job) }),
                )
            } else if (!r.ok && r.status !== 404 && r.status !== 410)
              throw await error(r)
          }
          await forget(job.id)
          if (!finishedStates.has(job.state)) job.state = 'Cancelled'
          job.file = null
        } catch (e) {
          job.state = 'Failed'
          job.error = e.message || 'Could not cancel this upload.'
        } finally {
          renderTransfers()
        }
      })(),
    )
})
document.addEventListener('dragover', (e) => {
  const target = e.target.closest('[data-upload-url]')
  if (target && [...e.dataTransfer.types].includes('Files')) {
    e.preventDefault()
    target.dataset.dropActive = 'true'
  }
})
document.addEventListener('dragleave', (e) => {
  const target = e.target.closest('[data-upload-url]')
  if (target && !target.contains(e.relatedTarget))
    delete target.dataset.dropActive
})
document.addEventListener('drop', (e) => {
  const target = e.target.closest('[data-upload-url]')
  if (!target || ![...e.dataTransfer.types].includes('Files')) return
  e.preventDefault()
  delete target.dataset.dropActive
  const items = e.dataTransfer.items.length
    ? [...e.dataTransfer.items]
        .filter((i) => i.kind === 'file')
        .map((i) => ({ entry: i.webkitGetAsEntry?.(), file: i.getAsFile() }))
    : [...e.dataTransfer.files].map((file) => ({ file }))
  safely(drop(items))
})
