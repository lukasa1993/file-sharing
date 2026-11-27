import { uploadFile } from './transfer-client.js'

const id = (name) => document.getElementById(name)
const { page, alias } = document.body.dataset
const linkEndpoint = '/api/links/' + encodeURIComponent(alias)
const activeUploads = new Set()
let user = null
let email = ''
let editing = null
let confirmation = null
let filePages = 1
let libraryVersion = 0
let loadedFiles = []
let loadedLinks = []
let nextFileCursor = null

function message(error) {
  return error instanceof Error
    ? error.message
    : 'Something went wrong. Please try again.'
}

function feedback(error) {
  id('feedback').textContent = message(error)
  id('feedback').hidden = false
}

function clearFeedback() {
  id('feedback').hidden = true
  id('feedback').textContent = ''
}

async function api(path, method = 'GET', values, signal) {
  const options = {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  }
  if (values !== undefined) {
    options.headers = { 'Content-Type': 'application/json' }
    options.body = JSON.stringify(values)
  }
  const result = await fetch(path, options)
  if (result.status === 204) return null
  const data = await result.json()
  if (!result.ok)
    throw new Error(data.error || 'The request failed. Please try again.')
  return data
}

function button(label, action) {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = 'text'
  node.textContent = label
  node.addEventListener('click', action)
  return node
}

function anchor(label, href) {
  const node = document.createElement('a')
  node.href = href
  node.textContent = label
  return node
}

function row(name, detail, controls) {
  const item = document.createElement('li')
  const copy = document.createElement('div')
  copy.className = 'row-copy'
  const title = document.createElement('span')
  title.className = 'line-label'
  title.textContent = name
  const metadata = document.createElement('p')
  metadata.className = 'meta'
  metadata.textContent = detail
  copy.append(title, metadata)
  const actions = document.createElement('div')
  actions.className = 'actions'
  actions.append(...controls)
  item.append(copy, actions)
  return item
}

function size(bytes) {
  if (bytes < 1000) return bytes + (bytes === 1 ? ' byte' : ' bytes')
  const scale = Math.min(4, Math.floor(Math.log10(bytes) / 3))
  const value = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(bytes / 1000 ** scale)
  return value + ' ' + ['bytes', 'KB', 'MB', 'GB', 'TB'][scale]
}

function expiry(timestamp) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const expired = date.getTime() <= Date.now()
  return (
    (expired ? 'Expired ' : 'Expires ') +
    date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  )
}

function linkPath(link) {
  if (link.href) return link.href
  return (
    (link.kind === 'request' ? '/r/' : '/s/') + encodeURIComponent(link.alias)
  )
}

function downloadPath(file) {
  return '/api/transfers/files/' + encodeURIComponent(file.id) + '/download'
}

function showAuth(title, description) {
  id('auth').hidden = false
  id('auth-title').textContent = title
  id('auth-lead').textContent = description
  document.title = title + ' · lshare'
}

function updateAccount() {
  id('address').textContent = user?.email || ''
  id('account').hidden = !user
}

function withButton(node, action, fail = feedback) {
  if (node.disabled) return
  node.disabled = true
  void Promise.resolve()
    .then(action)
    .finally(() => {
      node.disabled = false
    })
    .catch((error) => fail(error))
}

function wireAuth() {
  const emailForm = id('email-form')
  const codeForm = id('code-form')
  const requestCode = async () => {
    await api('/api/auth/start', 'POST', { email })
    clearFeedback()
    emailForm.hidden = true
    codeForm.hidden = false
    id('auth-title').textContent = 'Check your email'
    id('auth-lead').textContent = 'We sent a sign-in code to ' + email + '.'
    id('code').value = ''
    id('code').focus()
  }
  emailForm.addEventListener('submit', (event) => {
    event.preventDefault()
    email = id('email').value.trim()
    withButton(emailForm.querySelector('button'), requestCode)
  })
  id('change-email').addEventListener('click', () => {
    clearFeedback()
    codeForm.hidden = true
    emailForm.hidden = false
    id('auth-title').textContent = 'Verify your email'
    id('auth-lead').textContent =
      'Enter the address where you want to receive your sign-in code.'
    id('email').focus()
  })
  id('resend').addEventListener('click', () => {
    withButton(id('resend'), async () => {
      await requestCode()
      id('notice').textContent = 'A new code was sent to ' + email + '.'
    })
  })
  codeForm.addEventListener('submit', (event) => {
    event.preventDefault()
    withButton(codeForm.querySelector('[type=submit]'), async () => {
      await api('/api/auth/verify', 'POST', { email, code: id('code').value })
      location.reload()
    })
  })
  id('logout').addEventListener('click', () => {
    if (activeUploads.size && !window.confirm('Cancel uploads and sign out?'))
      return
    withButton(id('logout'), async () => {
      for (const controller of activeUploads) controller.abort()
      await api('/api/auth/logout', 'POST', {})
      location.reload()
    })
  })
}

function showEditor(file) {
  editing = file
  id('link-form').reset()
  id('link-form').querySelector('details').open = false
  id('editor-title').textContent = file ? 'Share file' : 'Request files'
  id('editor-context').textContent = file
    ? file.name
    : 'Anyone you send this link to can verify their email and upload files to you.'
  id('access-field').hidden = !file
  id('password-field').hidden = true
  id('share-password').required = false
  id('create-link').textContent = file
    ? 'Create share link'
    : 'Create upload request'
  id('link-form').hidden = false
  id('link-result').hidden = true
  id('editor-error').hidden = true
  id('editor').setAttribute('aria-labelledby', 'editor-title')
  id('editor').showModal()
}

function showConfirm(title, details, label, handler) {
  confirmation = handler
  id('confirm-title').textContent = title
  id('confirm-help').textContent = details
  id('confirm-action').textContent = label
  id('confirm-error').hidden = true
  id('confirm').showModal()
  id('confirm').querySelector('[value=cancel]').focus()
}

function fileRow(file) {
  return row(
    file.name,
    [size(file.size), expiry(file.expiresAt)].filter(Boolean).join(' · '),
    [
      button('Share', () => showEditor(file)),
      anchor('Download', downloadPath(file)),
      button('Delete', () =>
        showConfirm(
          'Delete file?',
          'Deleting ' +
            file.name +
            ' also stops new downloads through its links.',
          'Delete file',
          async () => {
            await api(
              '/api/transfers/files/' + encodeURIComponent(file.id),
              'DELETE',
            )
            id('notice').textContent = file.name + ' was deleted.'
          },
        ),
      ),
    ],
  )
}

function shareRow(link, files) {
  const path = linkPath(link)
  const file = files.find((entry) => entry.id === link.fileId)
  const active =
    !link.revoked && (!link.expiresAt || link.expiresAt > Date.now())
  const access = {
    public: 'Anyone with the link',
    verified: 'Verified email required',
    password: 'Password required',
  }
  const description = [
    link.kind === 'request' ? 'Upload request' : file?.name || 'File download',
    link.revoked ? 'Withdrawn' : access[link.access],
    expiry(link.expiresAt),
  ]
    .filter(Boolean)
    .join(' · ')
  const controls = active
    ? [
        anchor('Open', path),
        button('Copy link', () =>
          copyLink(new URL(path, location.origin).href, id('notice')),
        ),
        button('Withdraw', () =>
          showConfirm(
            'Withdraw link?',
            'People who open ' +
              path +
              ' will no longer be able to start a transfer.',
            'Withdraw link',
            async () => {
              await api('/api/shares/' + encodeURIComponent(link.id), 'DELETE')
              id('notice').textContent = 'Link withdrawn.'
            },
          ),
        ),
      ]
    : []
  return row(path, description, controls)
}

async function refreshLibrary() {
  const version = ++libraryVersion
  const [first, collection] = await Promise.all([
    api('/api/transfers/files'),
    api('/api/shares'),
  ])
  const files = [...first.files]
  let cursor = first.nextCursor
  for (let pageNumber = 1; cursor && pageNumber < filePages; pageNumber++) {
    const page = await api(
      '/api/transfers/files?' + new URLSearchParams({ cursor }),
    )
    if (version !== libraryVersion) return
    files.push(...page.files)
    cursor = page.nextCursor
  }
  if (version !== libraryVersion) return
  loadedFiles = files
  loadedLinks = collection.shares
  nextFileCursor = cursor
  renderLibrary()
}

function renderLibrary() {
  id('files').replaceChildren(...loadedFiles.map(fileRow))
  id('links').replaceChildren(
    ...loadedLinks.map((link) => shareRow(link, loadedFiles)),
  )
  id('more-files').hidden = !nextFileCursor
  id('files-empty').hidden = !!loadedFiles.length
  id('links-empty').hidden = !!loadedLinks.length
}

async function loadMoreFiles() {
  if (!nextFileCursor) return
  const version = libraryVersion
  const more = await api(
    '/api/transfers/files?' + new URLSearchParams({ cursor: nextFileCursor }),
  )
  if (version !== libraryVersion) return
  loadedFiles.push(...more.files)
  nextFileCursor = more.nextCursor
  filePages++
  renderLibrary()
}

async function copyLink(url, status) {
  try {
    await navigator.clipboard.writeText(url)
    status.textContent = 'Link copied.'
  } catch {
    if (id('editor')?.open) {
      id('created-url').select()
      status.textContent = 'Copy the selected link.'
    } else {
      id('notice').textContent = 'Copy this link: ' + url
    }
  }
}

function wireEditor() {
  id('more-files').addEventListener('click', () => {
    withButton(id('more-files'), loadMoreFiles)
  })
  id('new-request').addEventListener('click', () => showEditor(null))
  id('access').addEventListener('change', () => {
    const protectedLink = id('access').value === 'password'
    id('password-field').hidden = !protectedLink
    id('share-password').required = protectedLink
  })
  for (const close of document.querySelectorAll('[data-close]'))
    close.addEventListener('click', () => id('editor').close())
  id('copy-created').addEventListener('click', () =>
    copyLink(id('created-url').value, id('copy-status')),
  )
  id('link-form').addEventListener('submit', (event) => {
    event.preventDefault()
    withButton(
      id('create-link'),
      async () => {
        const access = editing ? id('access').value : 'verified'
        const values = { kind: editing ? 'file' : 'request', access }
        if (editing) values.fileId = editing.id
        if (access === 'password') values.password = id('share-password').value
        if (id('alias').value.trim()) values.alias = id('alias').value.trim()
        if (id('expiration').value)
          values.expiresAt =
            Date.now() + Number(id('expiration').value) * 3600000
        const link = await api('/api/shares', 'POST', values)
        const url = new URL(linkPath(link), location.origin).href
        id('created-url').value = url
        id('open-created').href = url
        id('copy-status').textContent = ''
        id('share-password').value = ''
        id('link-form').hidden = true
        id('link-result').hidden = false
        id('editor').setAttribute('aria-labelledby', 'ready-title')
        id('copy-created').focus()
        await refreshLibrary().catch(feedback)
      },
      (error) => {
        id('editor-error').textContent = message(error)
        id('editor-error').hidden = false
      },
    )
  })
  id('confirm-action').addEventListener('click', () => {
    if (!confirmation) return
    withButton(
      id('confirm-action'),
      async () => {
        await confirmation()
        id('confirm').close()
        await refreshLibrary()
      },
      (error) => {
        id('confirm-error').textContent = message(error)
        id('confirm-error').hidden = false
      },
    )
  })
}

function wirePicker() {
  const drop = id('drop')
  const picker = id('picker')
  const pending = []
  let busy = false
  function schedule(file) {
    const item = document.createElement('li')
    const copy = document.createElement('div')
    copy.className = 'queue-copy'
    const title = document.createElement('span')
    title.className = 'line-label'
    title.textContent = file.name
    const state = document.createElement('p')
    state.className = 'meta'
    state.setAttribute('role', 'status')
    state.textContent = 'Waiting to upload · ' + size(file.size)
    const progress = document.createElement('progress')
    progress.max = file.size || 1
    progress.value = 0
    progress.setAttribute('aria-label', 'Upload progress for ' + file.name)
    const controller = new AbortController()
    const control = button('Cancel', () => {
      controller.abort()
      state.textContent = 'Cancelled.'
      control.remove()
      progress.remove()
    })
    copy.append(title, progress, state)
    item.append(copy, control)
    id('uploads').append(item)
    pending.push(async () => {
      if (controller.signal.aborted) return
      activeUploads.add(controller)
      try {
        state.textContent = 'Uploading · ' + size(file.size)
        await uploadFile(file, {
          ...(page === 'request' && { requestId: alias }),
          signal: controller.signal,
          onProgress(sent) {
            progress.value = sent
          },
        })
        progress.value = progress.max
        state.textContent = 'Uploaded · ' + size(file.size)
        control.remove()
        if (page === 'home') await refreshLibrary().catch(feedback)
      } catch (error) {
        if (controller.signal.aborted) return
        state.textContent = message(error)
        progress.remove()
        control.replaceWith(
          button('Retry upload', () => {
            item.remove()
            enqueue([file])
          }),
        )
      } finally {
        activeUploads.delete(controller)
      }
    })
  }
  async function drain() {
    if (busy) return
    busy = true
    try {
      while (pending.length) await pending.shift()()
    } finally {
      busy = false
    }
  }
  function enqueue(files) {
    for (const file of files) schedule(file)
    void drain().catch(feedback)
  }
  picker.addEventListener('change', () => {
    enqueue(picker.files)
    picker.value = ''
  })
  drop.addEventListener('dragover', (event) => {
    event.preventDefault()
    drop.dataset.over = ''
  })
  drop.addEventListener('dragleave', () => delete drop.dataset.over)
  drop.addEventListener('drop', (event) => {
    event.preventDefault()
    delete drop.dataset.over
    if (event.dataTransfer) enqueue(event.dataTransfer.files)
  })
  window.addEventListener('beforeunload', (event) => {
    if (!activeUploads.size) return
    event.preventDefault()
    event.returnValue = ''
  })
}

function prepareRecipient(link) {
  const request = page === 'request'
  if (link.kind !== (request ? 'request' : 'file'))
    throw new Error('This link is unavailable.')
  if (!link.authorized && link.access === 'verified') {
    showAuth(
      'Verify your email',
      request
        ? 'Sign in to send files to this upload request.'
        : 'Sign in to download this shared file.',
    )
    return
  }
  id('recipient').hidden = false
  if (request) {
    id('recipient-description').textContent =
      'Files you add go to the person who sent this link. Only the recipient can see the collection.'
    wirePicker()
    return
  }
  if (!link.authorized && link.access === 'password') {
    id('recipient-description').textContent =
      'Enter the password from the sender to download the file.'
    id('unlock').hidden = false
    id('unlock').action = linkEndpoint + '/download'
    const issue = new URLSearchParams(location.search).get('error')
    if (issue === 'password')
      feedback(
        new Error(
          'Incorrect password. Check the password from the sender and try again.',
        ),
      )
    if (issue === 'try-later')
      feedback(new Error('Too many attempts. Wait a minute and try again.'))
    return
  }
  if (!link.authorized) throw new Error('This file is unavailable.')
  id('recipient-title').textContent = link.name || 'Shared file'
  id('recipient-description').textContent = [
    Number.isFinite(link.size) ? size(link.size) : '',
    expiry(link.expiresAt),
  ]
    .filter(Boolean)
    .join(' · ')
  id('download-area').hidden = false
  id('download').href = linkEndpoint + '/download'
}

async function initialize() {
  wireAuth()
  id('retry-open').addEventListener('click', () => location.reload())
  const current = await api('/api/auth/me')
  user = current.user
  updateAccount()
  if (page !== 'home') {
    prepareRecipient(await api(linkEndpoint))
  } else if (!user) {
    showAuth('Sign in', 'Use your email to share or request files.')
  } else {
    await refreshLibrary()
    id('workspace').hidden = false
    wireEditor()
    wirePicker()
  }
}

void initialize()
  .finally(() => {
    id('loading').hidden = true
  })
  .catch((error) => {
    document.title = 'Unable to open · lshare'
    feedback(error)
    id('retry-open').hidden = false
  })
