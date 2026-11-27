import { $, all, formError, json, size } from './workspace.js'

export async function runFileOperation(form, endpoint, body) {
  const dialog = form.closest('dialog')
  const panel = $('[data-operation-progress]', form)
  const status = $('[data-operation-status]', panel)
  const bar = $('progress', panel)
  const cancel = $('[data-cancel-operation]', form)
  const controls = all('input,select', form)
  const close = all('[data-close]', dialog)
  const lifetime = new AbortController()
  let id,
    stopping = false,
    terminal
  panel.hidden = cancel.hidden = false
  cancel.disabled = true
  bar.removeAttribute('value')
  status.textContent = 'Preparing file operation…'
  close.forEach((button) => {
    button.hidden = true
  })
  controls.forEach((control) => {
    control.disabled = true
  })
  const stop = async () => {
    if (!id || stopping) return
    stopping = true
    cancel.disabled = true
    status.textContent = 'Stopping after the last completed item…'
    try {
      await json(endpoint, 'POST', { operation: 'cancel', id })
    } catch (error) {
      stopping = false
      cancel.disabled = false
      formError(form, error.message)
    }
  }
  cancel.addEventListener('click', stop, { signal: lifetime.signal })
  dialog.addEventListener(
    'cancel',
    (event) => {
      event.preventDefault()
      if (!cancel.disabled) cancel.click()
    },
    { signal: lifetime.signal },
  )
  dialog.addEventListener('close', () => lifetime.abort(), {
    signal: lifetime.signal,
  })
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      cache: 'no-store',
      signal: lifetime.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': $('meta[name=csrf-token]').content,
      },
      body: JSON.stringify({ ...body, progress: true }),
    })
    if (!response.ok)
      throw new Error(
        (await response.json()).error?.message || 'File operation failed.',
      )
    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += value
        let newline
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const event = JSON.parse(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          if (event.type === 'started') {
            id = event.id
            cancel.disabled = false
          } else if (event.type === 'progress' && !stopping) {
            const phase = event.phase === 'copying' ? 'Copying ' : 'Verifying '
            bar.max = Math.max(1, event.total)
            bar.value = event.bytes
            status.textContent =
              phase +
              event.ref.segments.at(-1) +
              ' · ' +
              size(event.bytes) +
              ' of ' +
              size(event.total) +
              (event.items > 1
                ? ' · Item ' + event.item + ' of ' + event.items
                : '')
          } else if (event.type === 'result') terminal = event
        }
      }
    } finally {
      reader.releaseLock()
    }
    if (!terminal)
      throw new Error(
        'Connection interrupted. Refresh the folder to check the result.',
      )
    if (terminal.status >= 400)
      throw new Error(
        terminal.result.error?.message || 'File operation failed.',
      )
    return terminal.result
  } finally {
    lifetime.abort()
    panel.hidden = cancel.hidden = true
    close.forEach((button) => {
      button.hidden = false
    })
    controls.forEach((control) => {
      control.disabled = false
    })
  }
}
