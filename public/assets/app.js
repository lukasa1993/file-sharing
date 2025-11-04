const DOUBLE_CONFIRM_ROOT = '[data-double-confirm-root]'
const FLASH_MESSAGE_SELECTOR = '[data-flash-message]'
const UPLOAD_SHARE_SELECTOR = '[data-upload-share-root]'
const RESUMABLE_TOGGLE_SELECTOR = '[data-upload-resumable-toggle]'
const STANDARD_PANEL_SELECTOR = '[data-upload-standard-panel]'
const RESUMABLE_PANEL_SELECTOR = '[data-upload-resumable-panel]'
const UPLOAD_FORM_SELECTOR = '[data-upload-share-form]'
const UPLOAD_SUBMIT_SELECTOR = '[data-upload-submit]'
const UPPY_ROOT_SELECTOR = '[data-uppy-root]'
const UPLOAD_PATH_SELECTOR = '[data-upload-path]'
const UPPY_SCRIPT_URL = '/assets/vendor/uppy.min.js'
const UPPY_CHUNK_SIZE = 1024 * 1024 * 5
const UPPY_MIN_HEIGHT = '20rem'

let uppyScriptPromise = null

let formCounter = 0

function resolveUppyGlobal() {
  const global = window.Uppy
  if (!global) {
    return null
  }

  let ctor = typeof global === 'function' ? global : global.Uppy
  const Dashboard = typeof global === 'function' ? global.Dashboard : global.Dashboard
  const XHRUpload = typeof global === 'function' ? global.XHRUpload : global.XHRUpload
  const GoldenRetriever = typeof global === 'function' ? global.GoldenRetriever : global.GoldenRetriever

  if (!ctor && typeof global.Core === 'function') {
    ctor = global.Core
  }

  if (ctor && Dashboard && XHRUpload) {
    return { ctor, Dashboard, XHRUpload, GoldenRetriever }
  }

  return null
}

function loadUppyScript() {
  let resolved = resolveUppyGlobal()
  if (resolved) {
    return Promise.resolve(resolved)
  }

  if (uppyScriptPromise) {
    return uppyScriptPromise
  }

  uppyScriptPromise = new Promise((resolve, reject) => {
    const resolveIfReady = () => {
      const global = resolveUppyGlobal()
      if (global) {
        resolve(global)
        return
      }
      reject(new Error('Uppy failed to load'))
    }

    const existing = document.querySelector(`script[src="${UPPY_SCRIPT_URL}"]`)
    if (existing) {
      existing.addEventListener('load', () => {
        existing.dataset.uppyLoaded = 'true'
        window.setTimeout(resolveIfReady, 0)
      }, { once: true })
      existing.addEventListener('error', () => {
        reject(new Error('Unable to load Uppy'))
      }, { once: true })

      if (existing.dataset.uppyLoaded === 'true') {
        window.setTimeout(resolveIfReady, 0)
      }
      return
    }

    const script = document.createElement('script')
    script.src = UPPY_SCRIPT_URL
    script.async = true
    script.addEventListener('load', () => {
      script.dataset.uppyLoaded = 'true'
      window.setTimeout(resolveIfReady, 0)
    }, { once: true })
    script.addEventListener('error', () => {
      reject(new Error('Unable to load Uppy'))
    }, { once: true })
    document.head.appendChild(script)
  }).catch((error) => {
    uppyScriptPromise = null
    throw error
  })

  return uppyScriptPromise
}

function toggleElementVisibility(element, hidden) {
  if (!(element instanceof HTMLElement)) {
    return
  }

  if (hidden) {
    element.classList.add('hidden')
    element.setAttribute('aria-hidden', 'true')
    element.setAttribute('hidden', '')
  } else {
    element.classList.remove('hidden')
    element.removeAttribute('aria-hidden')
    element.removeAttribute('hidden')
  }
}

function parseJsonBody(body) {
  if (!body) {
    return null
  }

  if (typeof body === 'string') {
    try {
      return JSON.parse(body)
    } catch {
      return null
    }
  }

  if (typeof body === 'object') {
    return body
  }

  return null
}

function ensureFormId(form) {
  if (!(form instanceof HTMLFormElement)) {
    return null
  }
  if (!form.id) {
    form.id = `double-confirm-form-${formCounter += 1}`
  }
  return form.id
}

function setupDoubleConfirm(root) {
  const trigger = root.querySelector('[data-double-confirm-trigger]')
  const overlay = root.querySelector('[data-double-confirm-overlay]')
  const container = root.querySelector('[data-double-confirm-container]')

  if (
    !(trigger instanceof HTMLElement) ||
    !(overlay instanceof HTMLElement) ||
    !(container instanceof HTMLElement)
  ) {
    return
  }

  const advance = container.querySelector('[data-double-confirm-advance]')
  const back = container.querySelector('[data-double-confirm-back]')
  const finalButton = container.querySelector('[data-double-confirm-final]')
  const cancelButtons = Array.from(
    container.querySelectorAll('[data-double-confirm-cancel]'),
  ).filter((button) => button instanceof HTMLElement)
  let isOpen = false

  const enclosingForm = root.closest('form')
  const formId = ensureFormId(enclosingForm)

  if (overlay.dataset.doubleConfirmPortaled !== 'true') {
    document.body.appendChild(overlay)
    overlay.dataset.doubleConfirmPortaled = 'true'
  }

  if (formId && finalButton instanceof HTMLElement) {
    finalButton.setAttribute('form', formId)
  }

  const focusAdvance = () => {
    if (advance instanceof HTMLElement) {
      advance.focus()
    }
  }

  const focusFinal = () => {
    if (finalButton instanceof HTMLElement) {
      finalButton.focus()
    }
  }

  const closeModal = () => {
    if (!isOpen) {
      return
    }
    container.dataset.stage = 'first'
    overlay.classList.add('hidden')
    overlay.setAttribute('aria-hidden', 'true')
    trigger.setAttribute('aria-expanded', 'false')
    document.removeEventListener('keydown', handleKeydown)
    trigger.focus()
    isOpen = false
  }

  const handleKeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeModal()
    }
  }

  const openModal = () => {
    if (isOpen) {
      return
    }
    container.dataset.stage = 'first'
    overlay.classList.remove('hidden')
    overlay.setAttribute('aria-hidden', 'false')
    trigger.setAttribute('aria-expanded', 'true')
    focusAdvance()
    document.addEventListener('keydown', handleKeydown)
    isOpen = true
  }

  trigger.addEventListener('click', (event) => {
    event.preventDefault()
    openModal()
  })

  if (advance instanceof HTMLElement) {
    advance.addEventListener('click', () => {
      container.dataset.stage = 'second'
      focusFinal()
    })
  }

  if (back instanceof HTMLElement) {
    back.addEventListener('click', () => {
      container.dataset.stage = 'first'
      focusAdvance()
    })
  }

  cancelButtons.forEach((button) => {
    button.addEventListener('click', () => {
      closeModal()
    })
  })

  if (finalButton instanceof HTMLElement) {
    finalButton.addEventListener('click', () => {
      closeModal()
    })
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      closeModal()
    }
  })
}

function initDoubleConfirm() {
  document.querySelectorAll(DOUBLE_CONFIRM_ROOT).forEach((node) => {
    if (node instanceof HTMLElement && node.dataset.doubleConfirmInitialized !== 'true') {
      node.dataset.doubleConfirmInitialized = 'true'
      setupDoubleConfirm(node)
    }
  })
}

function initFlashMessages() {
  const nodes = Array.from(document.querySelectorAll(FLASH_MESSAGE_SELECTOR)).filter(
    (node) => node instanceof HTMLElement,
  )

  if (nodes.length === 0) {
    return
  }

  const clearUrl = () => {
    const url = new URL(window.location.href)
    let removed = false

    if (url.searchParams.has('message')) {
      url.searchParams.delete('message')
      removed = true
    }

    if (url.searchParams.has('error')) {
      url.searchParams.delete('error')
      removed = true
    }

    if (removed) {
      const next = url.pathname + url.search + url.hash
      window.history.replaceState(window.history.state, '', next)
    }
  }

  const dismiss = () => {
    for (const node of nodes) {
      node.setAttribute('aria-hidden', 'true')
      node.style.transition = node.style.transition || 'opacity 200ms ease'
      node.style.opacity = '0'
      window.setTimeout(() => {
        node.remove()
      }, 200)
    }

    clearUrl()
  }

  window.setTimeout(dismiss, 5000)
}

function buildResumableHeaders(file, options) {
  const shareToken = options?.shareToken || ''
  const uploadPath = options?.uploadPath || ''
  const headers = {
    'X-Upload-Mode': 'resumable',
    'X-Upload-Id': file.id,
    'X-File-Name': encodeURIComponent(file.name),
    'X-File-Type': file.type || 'application/octet-stream',
    'X-File-Size': String(file.size),
  }

  if (shareToken) {
    headers['X-Share-Token'] = shareToken
  }

  if (uploadPath) {
    headers['X-Upload-Path'] = encodeURIComponent(uploadPath)
  }

  if (file.meta && typeof file.meta.relativePath === 'string' && file.meta.relativePath.length > 0) {
    headers['X-File-Relative-Path'] = encodeURIComponent(file.meta.relativePath)
  }

  const modified = Number.isFinite(file.meta?.modified) ? Number(file.meta.modified) : file.data?.lastModified
  if (Number.isFinite(modified)) {
    headers['X-File-Last-Modified'] = String(modified)
  }

  return headers
}

function setupUploadShare(root) {
  if (!(root instanceof HTMLElement)) {
    return
  }

  const form = root.querySelector(UPLOAD_FORM_SELECTOR)
  const toggle = root.querySelector(RESUMABLE_TOGGLE_SELECTOR)
  const standardPanel = root.querySelector(STANDARD_PANEL_SELECTOR)
  const resumablePanel = root.querySelector(RESUMABLE_PANEL_SELECTOR)
  const submitButton = root.querySelector(UPLOAD_SUBMIT_SELECTOR)
  const uppyTarget = root.querySelector(`${RESUMABLE_PANEL_SELECTOR} ${UPPY_ROOT_SELECTOR}`)
  const shareToken = root.dataset.shareToken || ''
  const pathInput = form?.querySelector(UPLOAD_PATH_SELECTOR)

  if (
    !(form instanceof HTMLFormElement) ||
    !(toggle instanceof HTMLInputElement) ||
    !(resumablePanel instanceof HTMLElement) ||
    !(uppyTarget instanceof HTMLElement)
  ) {
    return
  }

  let uppy = null
  let statusNode = null
  let pendingOutcome = null
  let uploadPath = ''

  if (pathInput instanceof HTMLInputElement) {
    uploadPath = pathInput.value.trim()
    pathInput.addEventListener('input', () => {
      uploadPath = pathInput.value.trim()
      if (uppy) {
        uppy.setMeta({ shareToken, uploadPath })
      }
    })
  }

  if (uppyTarget instanceof HTMLElement && !uppyTarget.style.minHeight) {
    uppyTarget.style.minHeight = UPPY_MIN_HEIGHT
  }

  const ensureStatusNode = () => {
    if (statusNode instanceof HTMLElement) {
      return statusNode
    }
    const existing = resumablePanel.querySelector('[data-upload-status]')
    if (existing instanceof HTMLElement) {
      statusNode = existing
      return statusNode
    }
    const node = document.createElement('p')
    node.dataset.uploadStatus = 'true'
    node.className = 'text-xs text-slate-400'
    resumablePanel.appendChild(node)
    statusNode = node
    return node
  }

  const setStatus = (message, tone = 'info') => {
    const node = ensureStatusNode()
    node.textContent = message
    node.className = `text-xs ${tone === 'error' ? 'text-rose-300' : 'text-slate-400'}`
    node.setAttribute('role', tone === 'error' ? 'alert' : 'status')
  }

  const resetStatus = () => {
    if (statusNode instanceof HTMLElement) {
      statusNode.remove()
    }
    statusNode = null
  }

  const cleanUppy = () => {
    if (uppy && typeof uppy.close === 'function') {
      uppy.close({ reason: 'user' })
    }
    uppy = null
    uppyTarget.innerHTML = ''
  }

  const deactivateResumableMode = () => {
    cleanUppy()
    if (!toggle.disabled) {
      toggle.checked = false
    } else {
      window.setTimeout(() => {
        toggle.checked = false
      }, 0)
    }
    toggle.disabled = false
    if (submitButton instanceof HTMLButtonElement) {
      submitButton.disabled = false
    }
    toggleElementVisibility(resumablePanel, true)
    if (standardPanel instanceof HTMLElement) {
      toggleElementVisibility(standardPanel, false)
    }
    pendingOutcome = null
    resetStatus()
  }

  const recordUploadOutcome = (payload) => {
    if (!payload) {
      return
    }

    const next = {
      redirect: payload.redirect ?? null,
      message: payload.message ?? null,
      error: payload.error ?? null,
      completed: payload.completed === true,
    }

    if (!pendingOutcome) {
      pendingOutcome = next
      return
    }

    pendingOutcome = {
      redirect: next.redirect ?? pendingOutcome.redirect ?? null,
      message: next.message ?? pendingOutcome.message ?? null,
      error: next.error ?? pendingOutcome.error ?? null,
      completed: next.completed || pendingOutcome.completed === true,
    }
  }

  const activateResumableMode = async () => {
    toggle.disabled = true
    if (submitButton instanceof HTMLButtonElement) {
      submitButton.disabled = true
    }

    toggleElementVisibility(resumablePanel, false)
    if (standardPanel instanceof HTMLElement) {
      toggleElementVisibility(standardPanel, true)
    }

    try {
      const uppyLib = await loadUppyScript()
      resetStatus()
      pendingOutcome = null

      const UppyConstructor = uppyLib.ctor
      if (typeof UppyConstructor !== 'function') {
        throw new Error('Uppy library did not expose a constructor.')
      }

      uppy = new UppyConstructor({
        autoProceed: false,
        allowMultipleUploadBatches: true,
        restrictions: {
          allowedFileTypes: null,
          maxFileSize: null,
          maxNumberOfFiles: null,
        },
        meta: {
          shareToken,
          uploadPath,
        },
      })

      uppy.setMeta({ shareToken, uploadPath })

      if (uppyLib.GoldenRetriever) {
        uppy.use(uppyLib.GoldenRetriever, { serviceWorker: false })
      }

      uppy.use(uppyLib.Dashboard, {
        inline: true,
        height: 420,
        target: uppyTarget,
        theme: 'dark',
        showLinkToFileUploadResult: false,
        proudlyDisplayPoweredByUppy: false,
        fileManagerSelectionType: 'filesAndFolders',
        note: 'Drop files or folders. Uploads resume automatically if interrupted.',
      })

      uppy.use(uppyLib.XHRUpload, {
        endpoint: form.action,
        method: 'POST',
        bundle: false,
        formData: false,
        limit: 3,
        responseType: 'text',
        withCredentials: false,
        headers: (file) => buildResumableHeaders(file, { shareToken, uploadPath }),
        chunkSize: UPPY_CHUNK_SIZE,
        resume: true,
        retryDelays: [0, 1000, 3000, 5000],
        timeout: 1000 * 60 * 5,
      })

      uppy.setOptions({
        allowMultipleUploads: true,
        allowMultipleUploadBatches: true,
      })

      uppy.on('file-added', (file) => {
        if (!file || !uppy) {
          return
        }

        const relativePath =
          typeof file.meta?.relativePath === 'string' && file.meta.relativePath.length > 0
            ? file.meta.relativePath
            : file.data?.webkitRelativePath || ''

        if (relativePath) {
          uppy.setFileMeta(file.id, { relativePath })
        }
      })

      uppy.on('upload', () => {
        setStatus('Uploading... keep this tab open until completion.', 'info')
        toggle.disabled = true
      })

      uppy.on('complete', (result) => {
        toggle.disabled = false
        if (result.failed && result.failed.length > 0) {
          setStatus('Some files failed to upload. Check the list above for details.', 'error')
          pendingOutcome = null
          return
        }

        if (pendingOutcome) {
          if (pendingOutcome.redirect) {
            window.location.href = pendingOutcome.redirect
            return
          }

          if (pendingOutcome.completed) {
            if (pendingOutcome.error) {
              setStatus(pendingOutcome.error, 'error')
            } else {
              setStatus(
                pendingOutcome.message || 'Upload link is now closed. Refresh to confirm.',
                'info',
              )
            }
            toggle.disabled = true
            if (submitButton instanceof HTMLButtonElement) {
              submitButton.disabled = true
            }
            pendingOutcome = null
            return
          }

          if (pendingOutcome.message) {
            setStatus(pendingOutcome.message, 'info')
          }

          if (pendingOutcome.error) {
            setStatus(pendingOutcome.error, 'error')
          }

          pendingOutcome = null
          return
        }

        setStatus('All uploads finished.', 'info')
      })

      uppy.on('upload-success', (_file, response) => {
        const payload = parseJsonBody(response?.body)
        if (payload) {
          recordUploadOutcome(payload)
        } else {
          recordUploadOutcome({ redirect: window.location.href })
        }
      })

      uppy.on('upload-error', (_file, error) => {
        pendingOutcome = null
        const payload = parseJsonBody(error?.response?.body)
        if (payload?.error) {
          setStatus(payload.error, 'error')
          return
        }
        setStatus(error?.message || 'Upload failed. Please try again.', 'error')
      })

      uppy.on('error', (error) => {
        pendingOutcome = null
        setStatus(error?.message || 'Upload failed. Please try again.', 'error')
      })
    } catch (error) {
      console.error(error)
      setStatus('Unable to load resumable uploader. Please use the standard form instead.', 'error')
      deactivateResumableMode()
    } finally {
      toggle.disabled = false
    }
  }

  const enableStandardMode = () => {
    toggle.checked = false
    deactivateResumableMode()
  }

  const enableResumableMode = () => {
    toggle.checked = true
    activateResumableMode().catch((error) => {
      console.error(error)
      setStatus('Unable to initialize resumable uploads. Falling back to form uploads.', 'error')
      enableStandardMode()
    })
  }

  toggle.addEventListener('change', () => {
    if (toggle.checked) {
      enableResumableMode()
    } else {
      enableStandardMode()
    }
  })

  form.addEventListener('submit', (event) => {
    if (toggle.checked && uppy) {
      event.preventDefault()
      uppy.upload().catch((error) => {
        console.error(error)
        setStatus('Upload failed. Please try again.', 'error')
      })
    }
  })

  root.dataset.uploadShareInitialized = 'true'

  enableResumableMode()
}

function initUploadShare() {
  document.querySelectorAll(UPLOAD_SHARE_SELECTOR).forEach((root) => {
    if (root instanceof HTMLElement && root.dataset.uploadShareInitialized !== 'true') {
      setupUploadShare(root)
    }
  })
}

const start = () => {
  initDoubleConfirm()
  initFlashMessages()
  initUploadShare()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true })
} else {
  start()
}
