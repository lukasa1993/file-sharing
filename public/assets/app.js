const DOUBLE_CONFIRM_ROOT = '[data-double-confirm-root]'
const FLASH_MESSAGE_SELECTOR = '[data-flash-message]'

let formCounter = 0

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

const start = () => {
  initDoubleConfirm()
  initFlashMessages()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true })
} else {
  start()
}
