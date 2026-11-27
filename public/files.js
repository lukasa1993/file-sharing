import {
  $,
  all,
  ask,
  json,
  size,
  clearChoice,
  closeDialogs,
  currentRef,
  initSelection,
  manager,
  navigate,
  notice,
  onWorkspaceReady,
  refKey,
  refresh,
  rowEntry,
  select,
  selection,
  show,
  syncSelection,
} from './workspace.js'
import {
  activate,
  applyPrefs,
  changePrefs,
  clipboardAction,
  dropMove,
  initActions,
  loadPrefs,
  menu,
  openPreview,
  openSaved,
  prefs,
} from './actions.js'
import { initUploads } from './uploads.js'

let anchorIndex = -1
let prefOwner = ''
let stream
let activeTypeTimer
let typed = ''
function guard(work) {
  Promise.resolve(work).catch((e) =>
    notice(e.message || 'This action could not be completed.', true),
  )
}
function init() {
  anchorIndex = -1
  initSelection()
  guard(initUploads(notice))
  const owner = $('[data-account]')?.dataset.account || ''
  if (owner && owner !== prefOwner) {
    prefOwner = owner
    guard(loadPrefs())
  } else applyPrefs()
  // Account changes and public links use native navigation and a fresh module.
  stream?.close()
  if ($('#admin-transfers')) {
    stream = new EventSource('/_/events')
    stream.addEventListener('transfers', (e) => {
      const list = $('#admin-transfers')
      if (!list) return
      try {
        const rows = JSON.parse(e.data)
        const body = $('tbody', list)
        const existing = new Map(
          [...body.rows].map((row) => [row.dataset.transferId, row]),
        )
        for (const t of rows) {
          let row = existing.get(t.id)
          if (!row) {
            row = body.insertRow()
            row.dataset.transferId = t.id
            for (let i = 0; i < 4; i++) row.insertCell()
            const cancel = document.createElement('button')
            cancel.type = 'button'
            cancel.textContent = 'Cancel transfer'
            cancel.dataset.cancelTransfer = t.id
            row.cells[3].append(cancel)
          }
          existing.delete(t.id)
          row.cells[0].textContent = t.kind
          row.cells[1].textContent =
            size(t.bytes) + (t.total == null ? '' : ' / ' + size(t.total))
          row.cells[2].textContent = size(t.bytesPerSecond) + '/s'
        }
        for (const row of existing.values()) row.remove()
        $('[data-transfer-empty]', list).hidden = rows.length > 0
        $('[data-transfer-table]', list).hidden = !rows.length
      } catch {
        notice('Transfer updates are unavailable.', true)
      }
    })
  }
}
function rangeCheck(row, checked, shift) {
  const rows = all('.file-row'),
    end = rows.indexOf(row)
  if (shift && anchorIndex >= 0)
    for (const el of rows.slice(
      Math.min(end, anchorIndex),
      Math.max(end, anchorIndex) + 1,
    ))
      select(rowEntry(el), checked)
  else select(rowEntry(row), checked)
  anchorIndex = end
  syncSelection()
}
function internal(a) {
  if (
    !a ||
    a.origin !== location.origin ||
    a.target ||
    a.hasAttribute('download') ||
    a.hasAttribute('data-rmx-document') ||
    !$('.app')
  )
    return false
  return (
    /^\/_\/(files|shares|trash|admin|account)\/?$/.test(a.pathname) && !a.hash
  )
}
onWorkspaceReady(init)
initActions()
init()
document.addEventListener('click', (e) => {
  const target = e.target
  if (!(target instanceof Element)) return
  const dialog = target.closest('dialog')
  if (target === dialog && dialog) {
    const r = dialog.getBoundingClientRect()
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      dialog.close()
  }
  const toggle = target.closest('button[data-navigation]')
  if (toggle) {
    const app = $('.app'),
      open = app.dataset.navigation !== 'open'
    app.dataset.navigation = open ? 'open' : ''
    toggle.setAttribute('aria-expanded', String(open))
    return
  }
  if ($('.app[data-navigation=open]') && !target.closest('.rail')) {
    delete $('.app').dataset.navigation
    toggleNavigation(false)
  }
  const b = target.closest('button')
  if (b?.dataset.cancelTransfer) {
    guard(
      ask('Cancel this active transfer?').then(async (confirmed) => {
        if (!confirmed) return
        await json('/_/api/v1/admin', 'POST', {
          action: 'cancelTransfer',
          id: b.dataset.cancelTransfer,
        })
        notice('Transfer canceled.')
      }),
    )
    return
  }
  if (b?.hasAttribute('data-close')) {
    b.closest('dialog')?.close()
    return
  }
  if (b?.dataset.open) {
    const name = b.dataset.open
    if (['favorites', 'recent'].includes(name)) openSaved(name)
    else show(name)
    return
  }
  if (b?.dataset.view) {
    guard(changePrefs({ view: b.dataset.view }))
    return
  }
  if (b?.dataset.sort) {
    let key = b.dataset.sort
    if (key === 'date') key = 'mtime'
    guard(
      changePrefs({ sort: prefs().sort === key ? key + '-desc' : key }).then(
        refresh,
      ),
    )
    return
  }
  if (b?.hasAttribute('data-refresh')) {
    guard(refresh())
    return
  }
  if (b?.hasAttribute('data-clear-selection')) {
    clearChoice()
    return
  }
  const row = target.closest('.file-row')
  if (b?.hasAttribute('data-row-menu') && row) {
    menu(rowEntry(row))
    return
  }
  if (target.id === 'select-all') {
    for (const el of all('.file-row')) select(rowEntry(el), target.checked)
    syncSelection()
    return
  }
  if (target.matches('[data-select]') && row) {
    rangeCheck(row, target.checked, e.shiftKey)
    return
  }
  if (
    !e.defaultPrevented &&
    e.button === 0 &&
    row &&
    !b &&
    !target.closest('label') &&
    (e.ctrlKey || e.metaKey || e.shiftKey)
  ) {
    e.preventDefault()
    rangeCheck(row, row.dataset.selected !== 'true', e.shiftKey)
    return
  }
  const a = target.closest('a')
  if (
    a &&
    e.button === 0 &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.shiftKey &&
    !e.altKey
  ) {
    if (a.hasAttribute('data-preview') && row) {
      e.preventDefault()
      guard(openPreview(rowEntry(row)))
      return
    }
    if (internal(a)) {
      e.preventDefault()
      guard(navigate(a.href))
      return
    }
  }
})
function toggleNavigation(open) {
  const b = $('button[data-navigation]')
  if (b) b.setAttribute('aria-expanded', String(open))
}
document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.file-row')
  if (row) {
    e.preventDefault()
    menu(rowEntry(row))
  }
})
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-sort-picker]'))
    guard(changePrefs({ sort: e.target.value }).then(refresh))
  if (e.target.matches('[data-theme-picker]'))
    guard(changePrefs({ theme: e.target.value }))
})
document.addEventListener('submit', (e) => {
  const form = e.target
  if (form.matches('.search-form')) {
    e.preventDefault()
    const url = new URL(form.action)
    url.search = new URLSearchParams(new FormData(form))
    guard(navigate(url))
    return
  }
  if (form.getAttribute('action') === '/logout') clearChoice()
})
window.addEventListener('popstate', () => {
  if ($('.app')) guard(navigate(location.href, { pop: true }))
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const app = $('.app')
    if (app) {
      delete app.dataset.navigation
      toggleNavigation(false)
    }
    return
  }
  if (
    e.target.closest('input,textarea,select,dialog,[contenteditable=true]') ||
    !manager()
  )
    return
  const modifier = e.ctrlKey || e.metaKey,
    key = e.key.toLowerCase()
  if (modifier && ['a', 'c', 'x', 'v'].includes(key)) {
    e.preventDefault()
    if (key === 'a') {
      for (const row of all('.file-row')) select(rowEntry(row), true)
      syncSelection()
    } else clipboardAction({ c: 'copy', x: 'move', v: 'paste' }[key])
    return
  }
  if (e.key === '/') {
    e.preventDefault()
    $('.search-input input')?.focus()
    return
  }
  const row = e.target.closest('.file-row')
  if (row && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
    e.preventDefault()
    const next =
      e.key === 'ArrowDown'
        ? row.nextElementSibling
        : row.previousElementSibling
    if (next) {
      $('.entry-name', next).focus()
      if (e.shiftKey) rangeCheck(next, true, true)
    }
    return
  }
  if (row && (e.key === 'F2' || e.key === 'Delete')) {
    e.preventDefault()
    guard(activate(e.key === 'F2' ? 'rename' : 'trash', [rowEntry(row)]))
    return
  }
  if (!modifier && !e.altKey && e.key.length === 1 && /\S/.test(e.key)) {
    typed += key
    clearTimeout(activeTypeTimer)
    activeTypeTimer = setTimeout(() => {
      typed = ''
    }, 800)
    const match = all('.file-row').find((r) =>
      rowEntry(r).name.toLocaleLowerCase().startsWith(typed),
    )
    if (match) $('.entry-name', match)?.focus()
  }
})
document.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.file-row')
  if (!row) return
  const item = rowEntry(row),
    chosen = selection()
  const group = chosen.some((it) => refKey(it.ref) === refKey(item.ref))
    ? chosen
    : [item]
  e.dataTransfer.setData(
    'application/x-fileserver-entries',
    JSON.stringify(group),
  )
  e.dataTransfer.effectAllowed = 'move'
})
document.addEventListener('dragover', (e) => {
  const row = e.target.closest('.file-row')
  if (
    row &&
    rowEntry(row).kind === 'directory' &&
    [...e.dataTransfer.types].includes('application/x-fileserver-entries')
  ) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }
})
document.addEventListener('drop', (e) => {
  const row = e.target.closest('.file-row'),
    data = e.dataTransfer.getData('application/x-fileserver-entries')
  if (row && data && rowEntry(row).kind === 'directory') {
    e.preventDefault()
    try {
      dropMove(data, rowEntry(row).ref)
    } catch {
      notice('Could not read the dragged selection.', true)
    }
  }
})
window.addEventListener('transfer-complete', (e) => {
  const ref = currentRef(),
    job = e.detail
  if (
    ref &&
    !document.querySelector('dialog[open]') &&
    ref.mountId === job.mount &&
    JSON.stringify(ref.segments) === JSON.stringify(job.parent)
  )
    guard(refresh())
  else if (ref)
    notice('Upload complete. Refresh the folder to see the new file.')
})
