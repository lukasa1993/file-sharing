export const $ = (s, root = document) => root.querySelector(s)
export const all = (s, root = document) => [...root.querySelectorAll(s)]
export const manager = () => $('#file-manager')
export const currentRef = () =>
  manager() ? JSON.parse(manager().dataset.ref) : null
export const refKey = (r) => JSON.stringify([r.mountId, ...r.segments])
export function refUrl(route, ref) {
  return (
    route +
    '?' +
    new URLSearchParams({ mount: ref.mountId, path: ref.segments.join('/') })
  )
}
export const size = (n) =>
  n == null
    ? '—'
    : n < 1024
      ? n + ' B'
      : n < 1048576
        ? (n / 1024).toFixed(1) + ' KB'
        : n < 1073741824
          ? (n / 1048576).toFixed(1) + ' MB'
          : (n / 1073741824).toFixed(2) + ' GB'
let noticeTimer
export function notice(message, isError = false) {
  const node = $('#live-message')
  if (!node) return
  node.textContent = message
  node.dataset.error = String(isError)
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => node.replaceChildren(), isError ? 12000 : 3600)
}
export function formError(form, message) {
  const node = $('[data-form-error]', form)
  if (!node) {
    notice(message, true)
    return
  }
  node.textContent = message
  node.hidden = !message
}
export function show(id) {
  const node = document.getElementById(id)
  if (!node || node.open) return node
  for (const other of all('dialog[open]')) other.close()
  node.showModal()
  return node
}
export function closeDialogs() {
  for (const d of all('dialog[open]')) d.close()
}
export async function json(url, method = 'GET', body) {
  const opts = {
    method,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  }
  if (method !== 'GET')
    opts.headers['X-CSRF-Token'] = $('meta[name=csrf-token]')?.content || ''
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const r = await fetch(url, opts)
  let data
  if (r.status !== 204) {
    try {
      data = await r.json()
    } catch {
      throw new Error(
        r.ok
          ? 'The server returned an unexpected response.'
          : 'Request failed (HTTP ' + r.status + ').',
      )
    }
  }
  if (!r.ok)
    throw new Error(
      data?.error?.message ||
        data?.message ||
        'Request failed (HTTP ' + r.status + ').',
    )
  return data
}
let scope = '',
  choices = new Map()
function savedKey() {
  return 'fileserver:selection:' + scope
}
export function initSelection() {
  const user = $('[data-account]')?.dataset.account || ''
  if (user !== scope) {
    scope = user
    choices = new Map()
    try {
      const saved = JSON.parse(sessionStorage.getItem(savedKey()) || '[]')
      for (const entry of saved) choices.set(refKey(entry.ref), entry)
    } catch {
      choices.clear()
    }
  }
  syncSelection()
}
export const selection = () => [...choices.values()]
export const rowEntry = (row) => JSON.parse(row.dataset.entry)
export function select(entry, checked) {
  const k = refKey(entry.ref)
  if (checked) choices.set(k, entry)
  else choices.delete(k)
}
export function clearChoice() {
  choices.clear()
  syncSelection()
}
export function syncSelection() {
  const rows = all('.file-row')
  for (const row of rows) {
    const chosen = choices.has(refKey(rowEntry(row).ref))
    row.dataset.selected = String(chosen)
    const box = $('[data-select]', row)
    if (box) box.checked = chosen
  }
  const allBox = $('#select-all')
  if (allBox) {
    const selected = rows.filter((r) => r.dataset.selected === 'true').length
    allBox.checked = rows.length > 0 && selected === rows.length
    allBox.indeterminate = selected > 0 && selected < rows.length
  }
  const tools = $('[data-selection-tools]')
  if (tools) {
    tools.hidden = !choices.size
    $('[data-selection-count]', tools).textContent = choices.size + ' selected'
  }
  try {
    if (scope) sessionStorage.setItem(savedKey(), JSON.stringify(selection()))
  } catch {
    // The selection remains available in memory when browser storage is disabled.
    return
  }
}
let readyCallback, controller
export function onWorkspaceReady(callback) {
  readyCallback = callback
}
export async function navigate(href, { replace = false, pop = false } = {}) {
  const dest = new URL(href, location.href)
  if (dest.origin !== location.origin || !$('.app')) {
    location.assign(dest.href)
    return
  }
  controller?.abort()
  const request = new AbortController()
  controller = request
  const current = $('.app')
  current.setAttribute('aria-busy', 'true')
  try {
    const r = await fetch(dest.href, {
      signal: request.signal,
      headers: { Accept: 'text/html' },
      cache: 'no-store',
    })
    if (
      (!r.ok && r.status !== 503) ||
      !r.headers.get('Content-Type')?.includes('text/html')
    ) {
      if (r.status === 401) {
        location.assign('/login')
        return
      }
      throw new Error('Could not open this page (HTTP ' + r.status + ').')
    }
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html'),
      next = doc.querySelector('.app')
    if (!next || next.dataset.account !== current.dataset.account) {
      location.assign(r.url)
      return
    }
    current.replaceWith(next)
    document.title = doc.title
    const csrf = doc.querySelector('meta[name=csrf-token]')
    if (csrf) $('meta[name=csrf-token]').content = csrf.content
    if (!pop) history[replace ? 'replaceState' : 'pushState']({}, '', r.url)
    window.scrollTo(0, 0)
    $('#workspace')?.focus({ preventScroll: true })
    readyCallback?.()
  } catch (e) {
    if (!request.signal.aborted) notice(e.message, true)
  } finally {
    current.removeAttribute('aria-busy')
  }
}
export function refresh() {
  return navigate(location.href, { replace: true })
}
export function working(form, fn) {
  if (form.getAttribute('aria-busy') === 'true') return
  const buttons = all('button[type=submit]', form)
  form.setAttribute('aria-busy', 'true')
  buttons.forEach((b) => (b.disabled = true))
  formError(form, '')
  Promise.resolve()
    .then(fn)
    .finally(() => {
      form.removeAttribute('aria-busy')
      buttons.forEach((b) => (b.disabled = false))
    })
    .catch((e) => formError(form, e.message || 'The request failed.'))
}
export function ask(message) {
  return new Promise((resolve) => {
    const d = $('#confirmation')
    if (!d) {
      resolve(window.confirm(message))
      return
    }
    d.returnValue = 'cancel'
    $('[data-confirm-text]', d).textContent = message
    d.addEventListener('close', () => resolve(d.returnValue === 'confirm'), {
      once: true,
    })
    show('confirmation')
  })
}
export async function copy(text) {
  if (!navigator.clipboard?.writeText)
    throw new Error(
      'Clipboard unavailable. Select the URL and copy it manually.',
    )
  await navigator.clipboard.writeText(text)
}
