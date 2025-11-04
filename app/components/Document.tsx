import type { Remix } from '@remix-run/dom'

type DocumentProps = {
  title?: string
  children?: Remix.RemixNode
}

export function Document({ title = 'File Sharing Demo', children }: DocumentProps) {
  let doubleConfirmScript = `
(() => {
  let setup = (root) => {
    let trigger = root.querySelector('[data-double-confirm-trigger]')
    let overlay = root.querySelector('[data-double-confirm-overlay]')
    let container = root.querySelector('[data-double-confirm-container]')
    if (!(trigger instanceof HTMLElement) || !(overlay instanceof HTMLElement) || !(container instanceof HTMLElement)) {
      return
    }

    let advance = container.querySelector('[data-double-confirm-advance]')
    let back = container.querySelector('[data-double-confirm-back]')
    let finalButton = container.querySelector('[data-double-confirm-final]')
    let cancelButtons = Array.from(container.querySelectorAll('[data-double-confirm-cancel]'))
    let isOpen = false

    function focusAdvance() {
      if (advance instanceof HTMLElement) {
        advance.focus()
      }
    }

    function focusFinal() {
      if (finalButton instanceof HTMLElement) {
        finalButton.focus()
      }
    }

    function closeModal() {
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

    function handleKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeModal()
      }
    }

    function openModal() {
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
      if (button instanceof HTMLElement) {
        button.addEventListener('click', () => {
          closeModal()
        })
      }
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

  document.querySelectorAll('[data-double-confirm-root]').forEach((root) => setup(root))
})()
  `.trim()

  return (
    <html lang="en" className="h-full">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
        <title>{title}</title>
      </head>
      <body className="min-h-full bg-slate-950 text-slate-100 antialiased selection:bg-sky-500/30 selection:text-white">
        {children}
        <script type="module" innerHTML={doubleConfirmScript} />
      </body>
    </html>
  )
}
