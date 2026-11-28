import {
  $,
  all,
  ask,
  clearChoice,
  closeDialogs,
  copy,
  currentRef,
  formError,
  json,
  manager,
  navigate,
  notice,
  refKey,
  refUrl,
  rowEntry,
  refresh,
  selection,
  show,
  size,
  working,
} from './workspace.js'
import { runFileOperation } from './operation-progress.js'
let targetRows = [],
  operation = '',
  shareKind = 'download',
  shareTargets = [],
  editId = '',
  copiedUrl = '',
  clip = null
const ops = '/_/api/v1/files/operations',
  shares = '/_/api/v1/shares'
let preferences = {
  theme: 'system',
  view: 'list',
  sort: 'name',
  favorites: [],
  recents: [],
}
export function prefs() {
  return preferences
}
export async function changePrefs(data) {
  const next = await json('/_/api/v1/preferences', 'POST', data)
  preferences = { ...preferences, ...next }
  applyPrefs()
}
export function applyPrefs() {
  document.documentElement.dataset.theme = preferences.theme || 'system'
  const sortPicker = $('[data-sort-picker]')
  if (sortPicker) sortPicker.value = preferences.sort || 'name'
  const picker = $('[data-theme-picker]')
  if (picker) picker.value = preferences.theme || 'system'
  const list = $('[data-list]')
  if (list) list.dataset.display = preferences.view || 'list'
  all('[data-view]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.view === preferences.view)),
  )
}
export async function loadPrefs() {
  if (!$('.app')) return
  try {
    preferences = { ...preferences, ...(await json('/_/api/v1/preferences')) }
    applyPrefs()
  } catch (e) {
    notice(e.message, true)
  }
}
export async function openSaved(kind) {
  const panel = $('[data-saved-list="' + kind + '"]')
  show(kind)
  let list = preferences.favorites
  if (kind === 'recent') {
    panel.textContent = 'Loading recently opened folders…'
    try {
      list = (await json('/_/api/v1/preferences')).recents
    } catch (e) {
      panel.textContent = e.message + ' Close and reopen Recent to try again.'
      return
    }
  }
  panel.replaceChildren()
  if (!list?.length) {
    const p = document.createElement('p')
    p.className = 'quiet'
    p.textContent =
      kind === 'favorites'
        ? 'Use a file’s actions to add a favorite.'
        : 'Folders you open will appear here.'
    panel.append(p)
  }
  for (const ref of list || []) {
    const a = document.createElement('a')
    a.className = 'saved-link'
    a.href = refUrl('/_/files', {
      mountId: ref.mountId,
      segments: kind === 'recent' ? ref.segments : ref.segments.slice(0, -1),
    })
    a.textContent = ref.mountId + ' / ' + ref.segments.join(' / ')
    a.title = kind === 'recent' ? 'Open folder' : 'Open containing folder'
    panel.append(a)
  }
}
export function menu(entry) {
  targetRows = [entry]
  const d = $('#file-actions')
  $('[data-file-context]', d).textContent = entry.name
  const perms = entry.permissions
  const can = (...names) => !perms || names.every((n) => perms.includes(n))
  const visible = {
    request: entry.kind === 'directory' && can('share', 'upload'),
    archive: can(entry.kind === 'directory' ? 'list' : 'read'),
    share: can('share'),
    rename: can('rename'),
    trash: can('delete'),
    download: entry.kind === 'file' && can('read'),
    open: can(entry.kind === 'file' ? 'read' : 'list'),
    copy: can('copy'),
    move: can('move'),
  }
  all('[data-action]', d).forEach((b) => {
    b.hidden = visible[b.dataset.action] === false
  })
  show('file-actions')
}
function fillSelect(select, records) {
  select.replaceChildren()
  for (const m of records) {
    if (m.readOnly) continue
    const option = document.createElement('option')
    option.value = m.id
    option.textContent = m.label
    select.append(option)
  }
}
function setLabel(d, selector, value) {
  const el = $(selector, d)
  if (el) el.textContent = value
}
function opDialog(name, rows, destination) {
  const config = {
    createDir: ['New folder', 'Create folder'],
    rename: ['Rename item', 'Rename'],
    copy: ['Copy items', 'Copy'],
    move: ['Move items', 'Move'],
    trash: ['Move to trash', 'Move to trash'],
  }
  const d = $('#operation'),
    f = $('form', d)
  f.reset()
  targetRows = rows
  operation = name
  setLabel(d, 'h2', config[name][0])
  setLabel(d, '[data-operation-submit]', config[name][1])
  const isDest = ['copy', 'move'].includes(name),
    hasName = ['createDir', 'rename'].includes(name)
  $('[data-name-field]', f).hidden = !hasName
  f.elements.name.required = hasName
  $('[data-destination-field]', f).hidden = !isDest
  $('[data-conflict-field]', f).hidden = !isDest && name !== 'rename'
  fillSelect(f.elements.mountId, JSON.parse(manager().dataset.mounts))
  const ref = destination || currentRef()
  f.elements.mountId.value = ref.mountId
  f.elements.path.value = ref.segments.join('/')
  f.elements.name.value = name === 'rename' ? rows[0].name : ''
  const summary =
    name === 'createDir'
      ? 'In ' + (ref.segments.join(' / ') || ref.mountId)
      : rows
          .map((r) => r.name)
          .slice(0, 3)
          .join(', ') +
        (rows.length > 3 ? ' and ' + (rows.length - 3) + ' more' : '')
  setLabel(d, '[data-operation-summary]', summary)
  formError(f, '')
  show('operation')
  if (hasName) {
    f.elements.name.focus()
    f.elements.name.select()
  }
}
function addShareTarget(form, ref) {
  const row = $(
    '[data-target-template]',
    form,
  ).content.firstElementChild.cloneNode(true)
  const mount = $('[data-target-mount]', row)
  if (ref) {
    if (![...mount.options].some((option) => option.value === ref.mountId))
      mount.add(new Option(ref.mountId, ref.mountId))
    mount.value = ref.mountId
    const input = $('[data-target-path]', row)
    input.value = '/' + ref.segments.join('/')
    // Preserve existing names containing newlines until their actual input is edited.
    input.dataset.original = JSON.stringify(ref.segments)
    input.defaultValue = input.value
  }
  $('[data-target-remove]', row).hidden = shareKind === 'upload'
  $('[data-target-list]', form).append(row)
  return row
}
function changedTargets(form) {
  const rows = all('[data-target-row]', form)
  if (!rows.length) throw new Error('Choose at least one shared item.')
  return rows.map((row) => {
    const path = $('[data-target-path]', row)
    const relative = path.value.replace(/^\//, '')
    const original = path.dataset.original
    return {
      mountId: $('[data-target-mount]', row).value,
      segments:
        original && path.value === path.defaultValue
          ? JSON.parse(original)
          : relative
            ? relative.split('/')
            : [],
    }
  })
}
function syncShareFields() {
  const f = $('#share-form')
  if (!f) return
  const password = f.elements.access.value === 'password',
    pub = f.elements.access.value === 'public',
    upload = shareKind === 'upload'
  $('[data-password-field]', f).hidden = !password
  f.elements.password.required = password && !editId
  $('[data-public-warning]', f).hidden = !pub
  f.elements.confirmPublic.required = pub
  const targetFields = $('[data-target-fields]', f)
  targetFields.hidden = targetFields.disabled =
    !editId || !f.elements.retarget.checked
  $('[data-mode-field]', f).hidden = upload
  for (const node of all(
    '[data-limit-field], [data-rate-field], [data-lease-help], [data-latest-field]',
    f,
  ))
    node.hidden = upload
  $('[data-cap-field]', f).hidden = !upload
}
function shareDialog(rows, kind, existing) {
  const d = $('#share-editor'),
    f = $('#share-form')
  f.reset()
  formError(f, '')
  shareKind = kind
  editId = existing?.id || ''
  shareTargets = existing?.targets || rows.map((r) => r.ref)
  $('[data-target-editor]', f).hidden = !existing
  $('[data-target-list]', f).replaceChildren()
  $('[data-target-add]', f).hidden = kind === 'upload'
  if (existing) {
    for (const target of shareTargets) addShareTarget(f, target)
    if (!shareTargets.length) addShareTarget(f)
  }
  setLabel(
    d,
    'h2',
    existing
      ? 'Edit shared link'
      : kind === 'upload'
        ? 'Request uploads'
        : 'Share files',
  )
  setLabel(
    d,
    '[data-share-submit]',
    existing
      ? 'Save changes'
      : kind === 'upload'
        ? 'Create upload link'
        : 'Create link',
  )
  setLabel(
    d,
    '[data-share-summary]',
    shareTargets.map((ref) => ref.segments.at(-1) || ref.mountId).join(', '),
  )
  if (existing) {
    f.elements.latestAtPath.checked = !!existing.latestAtPath
    if (existing.bytesPerSecond)
      f.elements.bandwidthKiB.value = existing.bytesPerSecond / 1024
    if (f.elements.ownerId) f.elements.ownerId.value = existing.ownerId || ''
    f.elements.alias.value = existing.alias
    f.elements.access.value = existing.access
    f.elements.mode.value = existing.mode
    if (existing.expiresAt) {
      const dt = new Date(existing.expiresAt)
      if (!Number.isNaN(dt.getTime()))
        f.elements.expiresAt.value = new Date(
          dt.getTime() - dt.getTimezoneOffset() * 60000,
        )
          .toISOString()
          .slice(0, 16)
    }
    if (existing.maxBytes) f.elements.maxMiB.value = existing.maxBytes / 1048576
    if (existing.maxDownloads)
      f.elements.maxDownloads.value = existing.maxDownloads
  }
  f.elements.expiresAt.dataset.original = f.elements.expiresAt.value
  syncShareFields()
  show('share-editor')
}
async function submitShare(f) {
  const value = f.elements
  const body = {
    kind: shareKind,
    ...(!editId
      ? { targets: shareTargets }
      : value.retarget.checked
        ? { targets: changedTargets(f) }
        : {}),
    mode: shareKind === 'upload' ? 'landing' : value.mode.value,
    access: value.access.value,
    confirmPublic: value.confirmPublic.checked,
  }
  if (!editId || value.expiresAt.dataset.original !== value.expiresAt.value) {
    body.expiresAt = value.expiresAt.value
      ? new Date(value.expiresAt.value).toISOString()
      : null
  }
  if (editId && value.ownerId?.value) body.ownerId = value.ownerId.value
  const alias = value.alias.value.trim()
  if (alias) body.alias = alias
  if (value.access.value === 'password' && value.password.value)
    body.password = value.password.value
  if (shareKind === 'upload')
    body.maxBytes = value.maxMiB.value
      ? Math.round(Number(value.maxMiB.value) * 1048576)
      : null
  else {
    body.maxDownloads = value.maxDownloads.value
      ? Number(value.maxDownloads.value)
      : null
    body.bytesPerSecond = value.bandwidthKiB.value
      ? Math.round(Number(value.bandwidthKiB.value) * 1024)
      : null
    body.latestAtPath = value.latestAtPath.checked
  }
  const result = await json(
    editId ? shares + '/' + encodeURIComponent(editId) : shares,
    editId ? 'PATCH' : 'POST',
    body,
  )
  copiedUrl = new URL('/' + result.alias, location.origin).href
  if (editId) await refresh()
  const url = $('[data-share-url]')
  url.value = copiedUrl
  setLabel($('#share-result'), '[data-copy-result]', '')
  show('share-result')
  url.focus()
  url.select()
}
async function submitOp(f) {
  const body = {
    operation,
    refs: targetRows.map((x) => x.ref),
    conflict: f.elements.conflict.value,
  }
  if (operation === 'createDir') body.refs = [currentRef()]
  if (['rename', 'createDir'].includes(operation))
    body.name = f.elements.name.value
  if (['copy', 'move'].includes(operation))
    body.destination = {
      mountId: f.elements.mountId.value,
      segments: f.elements.path.value.split('/').filter(Boolean),
    }
  const data = body.destination
    ? await runFileOperation(f, ops, body)
    : await json(ops, 'POST', body)
  clearChoice()
  closeDialogs()
  await refresh()
  if (data?.partial)
    notice(
      data.results
        .filter((r) => !r.ok)
        .map((r) => (r.ref?.segments.at(-1) || 'Item') + ': ' + r.error)
        .join(' · '),
      true,
    )
  else notice(operation === 'trash' ? 'Moved to trash.' : 'Files updated.')
}
function rememberClipboard(action, rows) {
  clip = { operation: action, rows }
  notice(
    rows.length +
      ' item' +
      (rows.length === 1 ? '' : 's') +
      ' ready to ' +
      action +
      '. Navigate to a folder and paste.',
  )
}
export function clipboardAction(action) {
  if (action === 'paste') {
    if (clip) opDialog(clip.operation, clip.rows, currentRef())
    return
  }
  const rows = selection()
  if (rows.length) rememberClipboard(action, rows)
}
export function dropMove(data, dest) {
  const rows = JSON.parse(data)
  if (Array.isArray(rows) && rows.length) opDialog('move', rows, dest)
}
export async function activate(action, rows, archiveFormat = 'tar') {
  if (action === 'createDir') {
    opDialog(action, [])
    return
  }
  if (action === 'request' && !rows.length) {
    const ref = currentRef()
    rows = [
      { name: ref.segments.at(-1) || ref.mountId, ref, kind: 'directory' },
    ]
  }
  if (!rows.length) return
  closeDialogs()
  const first = rows[0]
  if (action === 'share' || action === 'request') {
    shareDialog(rows, action === 'request' ? 'upload' : 'download')
    return
  }
  if (action === 'rename') {
    const active = all('.file-row').find(
      (row) =>
        JSON.stringify(JSON.parse(row.dataset.entry).ref) ===
        JSON.stringify(first.ref),
    )
    if (active) {
      inlineRename(active, first)
      return
    }
  }
  if (['createDir', 'rename', 'copy', 'move', 'trash'].includes(action)) {
    opDialog(action, rows)
    return
  }
  if (action === 'bulkRename') {
    targetRows = rows
    const f = $('#bulk-rename-form'),
      list = $('[data-bulk-names]', f)
    list.replaceChildren()
    for (const entry of rows) {
      const label = document.createElement('label'),
        input = document.createElement('input')
      label.textContent =
        entry.ref.mountId + ' / ' + entry.ref.segments.join(' / ')
      input.required = true
      input.maxLength = 255
      input.value = entry.name
      label.append(input)
      list.append(label)
    }
    formError(f, '')
    show('bulk-rename')
    return
  }
  if (action === 'archive') {
    const url = new URL('/_/archive', location.origin)
    url.searchParams.set('format', archiveFormat)
    for (const item of rows)
      url.searchParams.append('ref', JSON.stringify(item.ref))
    const a = document.createElement('a')
    a.href = url.href
    a.download = ''
    document.body.append(a)
    a.click()
    a.remove()
    return
  }
  if (action === 'download') {
    const a = document.createElement('a')
    a.href = refUrl('/_/download', first.ref)
    a.download = ''
    document.body.append(a)
    a.click()
    a.remove()
    return
  }
  if (action === 'open') {
    if (first.kind === 'directory')
      await navigate(refUrl('/_/files', first.ref))
    else await openPreview(first)
    return
  }
  if (action === 'favorite') {
    const same = (r) =>
      r.mountId === first.ref.mountId &&
      JSON.stringify(r.segments) === JSON.stringify(first.ref.segments)
    const remove = preferences.favorites.some(same)
    await changePrefs(
      remove ? { removeFavorite: first.ref } : { favorite: first.ref },
    )
    notice(remove ? 'Removed from favorites.' : 'Added to favorites.')
    return
  }
  if (action === 'details') {
    const dl = $('[data-details]')
    dl.replaceChildren()
    for (const [label, value] of Object.entries({
      Name: first.name,
      Kind: first.kind,
      Storage: first.ref.mountId,
      Path: '/' + first.ref.segments.join('/'),
      Size: first.kind === 'file' ? size(first.size) : '—',
      Modified: first.modifiedAt || '—',
    })) {
      const dt = document.createElement('dt'),
        dd = document.createElement('dd')
      dt.textContent = label
      dd.textContent = value
      dl.append(dt, dd)
    }
    show('details')
  }
}
function inlineRename(row, entry) {
  if (row.querySelector('.inline-rename')) return
  const link = $('.entry-name', row),
    form = document.createElement('form'),
    input = document.createElement('input'),
    save = document.createElement('button'),
    cancel = document.createElement('button')
  form.className = 'inline-rename'
  input.value = entry.name
  input.setAttribute('aria-label', 'New filename')
  input.required = true
  input.maxLength = 255
  save.textContent = 'Save'
  save.type = 'submit'
  cancel.textContent = 'Cancel'
  cancel.type = 'button'
  form.append(input, save, cancel)
  link.replaceWith(form)
  input.focus()
  input.select()
  const stop = () => {
    form.replaceWith(link)
    link.focus()
  }
  cancel.onclick = stop
  input.onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      stop()
    }
  }
  form.onsubmit = async (event) => {
    event.preventDefault()
    save.disabled = true
    try {
      if (input.value !== entry.name)
        await json(ops, 'POST', {
          operation: 'rename',
          refs: [entry.ref],
          name: input.value,
          conflict: 'reject',
        })
      clearChoice()
      await refresh()
      notice('Item renamed.')
    } catch (e) {
      notice(e.message, true)
      save.disabled = false
    }
  }
}
let previewTicket = 0,
  previewItem
const rasterTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
])
function neighboringImages() {
  return all('.file-row')
    .map(rowEntry)
    .filter(
      (item) =>
        item.kind === 'file' &&
        /\.(?:jpe?g|png|gif|webp|bmp)$/i.test(item.name) &&
        (!item.permissions || item.permissions.includes('read')),
    )
}
function syncGallerySize() {
  const surface = $('[data-gallery-surface]')
  if (!surface) return
  const expanded =
    document.fullscreenElement === surface ||
    surface.classList.contains('expanded')
  const button = $('[data-gallery-fullscreen]', surface)
  button.setAttribute('aria-pressed', String(expanded))
  button.textContent = document.fullscreenEnabled
    ? expanded
      ? 'Exit fullscreen'
      : 'Fullscreen'
    : expanded
      ? 'Exit expanded view'
      : 'Expand view'
}
async function changeImage(direction) {
  const ticket = previewTicket,
    gallery = neighboringImages()
  const index = gallery.findIndex(
    (entry) => refKey(entry.ref) === refKey(previewItem.ref),
  )
  if (index < 0) return
  for (
    let i = index + direction;
    i >= 0 && i < gallery.length;
    i += direction
  ) {
    const item = gallery[i]
    const response = await fetch(refUrl('/_/preview', item.ref) + '&probe=1', {
      method: 'HEAD',
      cache: 'no-store',
    })
    if (ticket !== previewTicket || !$('#preview')?.open) return
    if (
      response.ok &&
      rasterTypes.has(
        (response.headers.get('content-type') || '').split(';')[0],
      ) &&
      !response.headers
        .get('content-disposition')
        ?.toLowerCase()
        .startsWith('attachment')
    ) {
      await openPreview(item, response)
      return
    }
  }
  $('[data-adjacent="' + direction + '"]').disabled = true
}
export async function openPreview(entry, headers) {
  const ticket = ++previewTicket
  previewItem = entry
  const dialog = $('#preview'),
    host = $('[data-preview-body]', dialog)
  if (!dialog) return
  const url = refUrl('/_/preview', entry.ref)
  $('[data-preview-title]', dialog).textContent = entry.name
  $('[data-preview-download]', dialog).href = refUrl('/_/download', entry.ref)
  const inspect = $('[data-formatted-preview]', dialog)
  const ext = entry.name.split('.').pop().toLowerCase()
  inspect.hidden = ![
    'md',
    'markdown',
    'ts',
    'tsx',
    'py',
    'rs',
    'go',
    'css',
    'json',
    'sql',
    'tar',
  ].includes(ext)
  inspect.href = refUrl('/_/inspect', entry.ref)
  const nav = $('.gallery-nav', dialog)
  nav.hidden = true
  host.replaceChildren()
  host.textContent = 'Loading preview…'
  show('preview')
  const r =
    headers ||
    (await fetch(url + '&probe=1', { method: 'HEAD', cache: 'no-store' }))
  if (!dialog.open || ticket !== previewTicket) return
  if (!r.ok) {
    host.textContent = 'Preview unavailable. Download the file to open it.'
    return
  }
  const type = (r.headers.get('content-type') || '').split(';')[0]
  if (
    r.headers.get('content-disposition')?.toLowerCase().startsWith('attachment')
  ) {
    host.textContent = 'A preview is unavailable for this file.'
    return
  }
  let tag
  if (rasterTypes.has(type)) {
    tag = 'img'
    const gallery = neighboringImages()
    const index = gallery.findIndex(
      (item) => refKey(item.ref) === refKey(entry.ref),
    )
    for (const button of all('[data-adjacent]', nav))
      button.disabled =
        index < 0 || !gallery[index + Number(button.dataset.adjacent)]
    nav.hidden = false
    syncGallerySize()
  } else if (type.startsWith('audio/')) tag = 'audio'
  else if (type.startsWith('video/')) tag = 'video'
  if (tag) {
    const media = document.createElement(tag)
    if (tag === 'img') media.alt = entry.name
    else media.controls = true
    media.addEventListener(
      'error',
      () => {
        if (dialog.open && ticket === previewTicket && host.contains(media))
          host.textContent =
            'This browser could not display the file. Download it to open it.'
      },
      { once: true },
    )
    media.src = url
    host.replaceChildren(media)
    return
  }
  if (type === 'text/plain') {
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) throw new Error('Could not load preview.')
    if (!dialog.open || ticket !== previewTicket) return
    const text = await response.text(),
      version = response.headers.get('X-File-Version'),
      truncated = response.headers.get('X-Preview-Truncated') === 'true',
      canEdit = entry.permissions?.includes('modify') && version && !truncated
    const pre = document.createElement('pre')
    pre.textContent = text
    host.replaceChildren(pre)
    if (truncated) {
      const note = document.createElement('p')
      note.textContent =
        'Showing the beginning of this file. Download the original to read the rest.'
      host.prepend(note)
    }
    if (canEdit) {
      const edit = document.createElement('button')
      edit.textContent = 'Edit text'
      edit.type = 'button'
      host.append(edit)
      edit.onclick = () => {
        const area = document.createElement('textarea'),
          save = document.createElement('button')
        area.value = text
        area.setAttribute('aria-label', 'File contents')
        save.textContent = 'Save changes'
        save.type = 'button'
        host.replaceChildren(area, save)
        area.focus()
        save.onclick = async () => {
          save.disabled = true
          try {
            const result = await fetch(url, {
              method: 'PUT',
              headers: {
                'If-Match': version.startsWith('"')
                  ? version
                  : '"' + version + '"',
                'Content-Type': 'text/plain; charset=utf-8',
                'X-CSRF-Token': $('meta[name=csrf-token]').content,
              },
              body: area.value,
            })
            if (!result.ok)
              throw new Error(
                result.status === 412
                  ? 'The file changed. Reopen it to edit the latest version.'
                  : 'Unable to save the file.',
              )
            dialog.close()
            await refresh()
            notice('Changes saved.')
          } catch (e) {
            notice(e.message, true)
          } finally {
            save.disabled = false
          }
        }
      }
    }
    return
  }
  host.textContent = 'A preview is unavailable for this file.'
}
export function initActions() {
  document.addEventListener('fullscreenchange', syncGallerySize)
  document.addEventListener('keydown', (e) => {
    const nav = $('#preview[open] .gallery-nav:not([hidden])')
    if (!nav || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const direction =
      e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    if (direction) {
      e.preventDefault()
      const button = $('[data-adjacent="' + direction + '"]', nav)
      if (!button.disabled) button.click()
    } else if (
      e.key === 'Escape' &&
      nav.parentElement.classList.contains('expanded')
    ) {
      e.preventDefault()
      nav.parentElement.classList.remove('expanded')
      syncGallerySize()
    }
  })
  document.addEventListener('submit', (event) => {
    const f = event.target
    if (f.id === 'bulk-rename-form') {
      event.preventDefault()
      working(f, async () => {
        const inputs = all('[data-bulk-names] input', f)
        const entries = targetRows
          .map((entry, index) => ({
            ref: entry.ref,
            name: inputs[index].value,
            original: entry.name,
          }))
          .filter((row) => row.original !== row.name)
          .map(({ ref, name }) => ({ ref, name }))
        if (entries.length) {
          const result = await json(ops, 'POST', {
            operation: 'bulkRename',
            entries,
            conflict: 'reject',
          })
          if (result?.partial) {
            const failures = result.results.filter((row) => !row.ok)
            clearChoice()
            closeDialogs()
            await refresh()
            notice(
              failures
                .map(
                  (row) =>
                    (row.ref?.segments.at(-1) || 'Item') + ' — ' + row.error,
                )
                .join(' · '),
              true,
            )
            return
          }
        }
        clearChoice()
        closeDialogs()
        await refresh()
        notice('Selected items renamed.')
      })
    }
    if (f.id === 'operation-form') {
      event.preventDefault()
      working(f, () => submitOp(f))
    }
    if (f.id === 'share-form') {
      event.preventDefault()
      working(f, () => submitShare(f))
    }
    if (f.matches('[data-json-form]')) {
      event.preventDefault()
      working(f, async () => {
        if (f.dataset.confirm && !(await ask(f.dataset.confirm + '?'))) return
        const fields = Object.fromEntries(new FormData(f))
        if (fields.principal) {
          const [subjectType, subjectId] = fields.principal.split(':')
          fields.subjectType = subjectType
          fields.subjectId = subjectId
          delete fields.principal
        }
        for (const [key, value] of Object.entries(fields)) {
          if (key === 'enabled' && value === 'keep') delete fields[key]
          else if (key === 'retentionDays' && value === '') fields[key] = null
          else if (
            ['admin', 'member', 'enabled'].includes(key) &&
            (value === 'true' || value === 'false')
          )
            fields[key] = value === 'true'
          else if (
            ['trashRetentionDays', 'retentionDays', 'days', 'bytes'].includes(
              key,
            ) &&
            value !== ''
          )
            fields[key] = Number(value)
          else if (
            value === '' &&
            ['brand', 'label', 'trashRetentionDays'].includes(key)
          )
            delete fields[key]
        }
        const result = await json(f.dataset.endpoint, 'POST', fields)
        if (result?.token) {
          $('[data-new-token]').value = result.token
          show('token-result')
          return
        }
        await refresh()
        notice('Changes saved.')
      })
    }
  })
  document.addEventListener(
    'close',
    (e) => {
      if (e.target.id === 'token-result') {
        const field = $('[data-new-token]', e.target)
        field.value = ''
        field.type = 'password'
        refresh().catch((err) => notice(err.message, true))
      }
      if (e.target.id === 'preview') {
        previewTicket++
        $('[data-gallery-surface]', e.target)?.classList.remove('expanded')
        $('[data-preview-body]', e.target)?.replaceChildren()
      }
    },
    true,
  )
  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-share-select]')) {
      const count = all('[data-share-select]:checked').length
      $('.batch-share-tools').hidden = count === 0
      $('[data-share-total]').textContent = count + ' selected'
    }
    if (
      e.target.matches('#share-form [name=access], #share-form [name=retarget]')
    )
      syncShareFields()
  })
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b) return
    const work = async () => {
      if (b.hasAttribute('data-show-token')) {
        const field = $('[data-new-token]', b.closest('dialog'))
        const visible = field.type === 'password'
        field.type = visible ? 'text' : 'password'
        b.textContent = visible ? 'Hide token' : 'Show token'
        b.setAttribute('aria-pressed', String(visible))
        return
      }
      if (b.hasAttribute('data-copy-token')) {
        const field = $('[data-new-token]', b.closest('dialog'))
        if (!navigator.clipboard?.writeText) {
          field.type = 'text'
          field.select()
          notice('Press Ctrl+C or Command+C to copy the selected token.')
          return
        }
        await navigator.clipboard.writeText(field.value)
        notice('Token copied.')
        return
      }
      if (b.hasAttribute('data-adjacent')) {
        await changeImage(Number(b.dataset.adjacent))
        return
      }
      if (b.hasAttribute('data-gallery-fullscreen')) {
        const surface = b.closest('[data-gallery-surface]')
        if (document.fullscreenElement === surface)
          await document.exitFullscreen()
        else if (document.fullscreenEnabled) await surface.requestFullscreen()
        else surface.classList.toggle('expanded')
        syncGallerySize()
        return
      }
      if (b.hasAttribute('data-target-add')) {
        $('[data-target-path]', addShareTarget(b.form)).focus()
        return
      }
      if (b.hasAttribute('data-target-remove')) {
        b.closest('[data-target-row]').remove()
        return
      }
      if (b.dataset.shareBatch) {
        const ids = all('[data-share-select]:checked').map((el) => el.value)
        if (
          !ids.length ||
          !(await ask(
            'Apply ' +
              b.dataset.shareBatch +
              ' to ' +
              ids.length +
              ' selected links?',
          ))
        )
          return
        await json(shares + '/batch', 'POST', {
          operation: b.dataset.shareBatch,
          ids,
        })
        await refresh()
        notice('Selected links updated.')
        return
      }
      if (b.dataset.action) {
        const rows = b.closest('#file-actions')
          ? targetRows
          : b.closest('[data-selection-tools]')
            ? selection()
            : []
        await activate(b.dataset.action, rows, b.dataset.archiveFormat)
      } else if (b.hasAttribute('data-copy-result-url')) {
        await copy(copiedUrl)
        $('[data-copy-result]').textContent = 'Link copied.'
      } else if (b.closest('[data-share-record]')) {
        const row = JSON.parse(
            b.closest('[data-share-record]').dataset.shareRecord,
          ),
          url = new URL('/' + row.alias, location.origin).href
        if (b.hasAttribute('data-copy-share')) {
          await copy(url)
          notice('Link copied.')
        }
        if (b.hasAttribute('data-share-history')) {
          const info = await json(shares + '/' + row.id),
            list = $('[data-history-list]')
          list.replaceChildren()
          if (info.kind === 'download') {
            const usage = document.createElement('p')
            usage.textContent =
              Number(info.requests || 0) +
              (info.requests === 1
                ? ' transfer request · '
                : ' transfer requests · ') +
              size(info.bytesServed || 0) +
              ' served'
            list.append(usage)
            if (info.maxDownloads !== null) {
              const budget = document.createElement('p')
              budget.textContent =
                Number(info.usedTransfers || 0) +
                ' of ' +
                info.maxDownloads +
                ' download leases used'
              list.append(budget)
            }
            if (info.lastAccess) {
              const last = document.createElement('p')
              last.textContent =
                'Last transfer ' + new Date(info.lastAccess).toLocaleString()
              list.append(last)
            }
          }
          for (const change of info.history || []) {
            const p = document.createElement('p')
            p.textContent =
              '/' + change.alias + ' · ' + new Date(change.at).toLocaleString()
            list.append(p)
          }
          if (!info.history?.length) {
            const p = document.createElement('p')
            p.textContent = 'No previous aliases.'
            list.append(p)
          }
          show('share-history')
        }
        if (b.hasAttribute('data-edit-share')) shareDialog([], row.kind, row)
        if (b.hasAttribute('data-toggle-share')) {
          await json(shares + '/' + row.id, 'PATCH', { enabled: !row.enabled })
          await refresh()
        }
        if (
          b.hasAttribute('data-revoke-share') &&
          (await ask(
            'Revoke /' +
              row.alias +
              '? Anyone with this link will lose access.',
          ))
        ) {
          await json(shares + '/' + row.id, 'DELETE')
          await refresh()
          notice('Link revoked.')
        }
      } else if (b.dataset.trashOp) {
        const op = b.dataset.trashOp
        if (op === 'purge' && !(await ask('Permanently delete this item?')))
          return
        const data = {
          operation: op,
          ids: [b.dataset.trashId],
          conflict: 'reject',
        }
        try {
          await json(ops, 'POST', data)
        } catch (e) {
          if (
            op !== 'restore' ||
            !(await ask(e.message + ' Try restoring with an unused name?'))
          )
            throw e
          await json(ops, 'POST', { ...data, conflict: 'rename' })
        }
        await refresh()
        notice(op === 'restore' ? 'Item restored.' : 'Item deleted.')
      }
    }
    work().catch((err) => notice(err.message, true))
  })
}
