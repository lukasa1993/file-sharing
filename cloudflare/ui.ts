type Page = 'home' | 'share' | 'request'

const titles: Record<Page, string> = {
  home: 'Your files',
  share: 'Shared file',
  request: 'Upload request',
}

const drawings = {
  upload:
    '<path d="M12 16V3m-5 5 5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  file: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 13h6m-6 4h4"/>',
  link: '<path d="m8.5 15.5 7-7m-5 0 2.5-2.5a4.2 4.2 0 0 1 6 6l-2.5 2.5m-3 1-2.5 2.5a4.2 4.2 0 0 1-6-6l2.5-2.5"/>',
}

function icon(name: keyof typeof drawings) {
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${drawings[name]}</svg>`
}

function escape(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function picker() {
  return `<div class="drop" id="drop">
    <span class="stamp">${icon('upload')}</span>
    <div><h2>Add files</h2><p>Drop files here or choose them from your device. 100 MB per file · 30 days.</p></div>
    <label class="button primary picker">Choose files<input type="file" multiple aria-label="Choose files" id="picker"></label>
  </div><ul class="queue" id="uploads" aria-label="Upload progress"></ul>`
}

const verify = `<section class="auth" id="auth" hidden aria-labelledby="auth-title">
  <div class="auth-copy"><h1 id="auth-title">Sign in</h1><p id="auth-lead">Use your email to share or request files.</p>
  <form id="email-form"><label for="email">Email address</label><input id="email" name="email" type="email" required autocomplete="email" inputmode="email" maxlength="254">
    <button class="button primary" type="submit">Send verification code</button></form>
  <form id="code-form" hidden><label for="code">Verification code</label><input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{8}" minlength="8" maxlength="8" required aria-describedby="code-help">
    <p id="code-help">The 8-digit code expires in 10 minutes.</p><button class="button primary" type="submit">Verify email</button>
    <div class="inline"><button type="button" id="resend" class="text">Resend code</button><button type="button" id="change-email" class="text">Change email</button></div></form></div>
  <div class="folio" aria-hidden="true"><img src="/assets/lshare-folio.webp" width="880" height="880" alt=""></div>
</section>`

const editor = `<dialog id="editor" aria-labelledby="editor-title"><form id="link-form">
  <div class="dialog-top"><h2 id="editor-title">Share file</h2><button class="text" type="button" data-close>Close</button></div>
  <p id="editor-context"></p>
  <div id="access-field"><label for="access">Who can download</label><select id="access"><option value="public">Anyone with the link</option><option value="verified">People with a verified email</option><option value="password">People with the password</option></select></div>
  <div id="password-field" hidden><label for="share-password">Link password</label><input id="share-password" type="password" autocomplete="new-password" maxlength="128"></div>
  <details><summary>Link options</summary><label for="alias">Custom link name (optional)</label><input id="alias" autocomplete="off" spellcheck="false" placeholder="design-review">
    <label for="expiration">Link expires</label><select id="expiration"><option value="">Use default expiry</option><option value="1">In 1 hour</option><option value="24">In 1 day</option><option value="168">In 7 days</option></select></details>
  <p id="editor-error" role="alert" hidden></p><button type="submit" class="button primary" id="create-link">Create link</button></form>
  <div id="link-result" hidden><div class="dialog-top"><h2 id="ready-title">Link ready</h2><button class="text" type="button" data-close>Close</button></div><label for="created-url">Share this link</label><input id="created-url" type="url" readonly>
  <div class="inline"><button class="button primary" id="copy-created" type="button">Copy link</button><a class="button" id="open-created">Open link</a></div><p role="status" id="copy-status"></p></div></dialog>`

const home = `<section id="workspace" hidden aria-labelledby="workspace-title"><div class="heading"><div><h1 id="workspace-title">Your files</h1><p>Share a download, or request files from someone else.</p></div><button class="button" type="button" id="new-request">${icon('link')} Request files</button></div>
  ${picker()}
  <section class="library" aria-labelledby="file-title"><h2 id="file-title">Files</h2><p class="empty" id="files-empty">Uploaded files will appear here.</p><ul class="rows" id="files"></ul><button class="text" id="more-files" type="button" hidden>Load more files</button></section>
  <section class="library" aria-labelledby="link-title"><h2 id="link-title">Your links</h2><p class="empty" id="links-empty">Links you create for downloads and upload requests will appear here.</p><ul class="rows" id="links"></ul></section></section>
  ${editor}<dialog id="confirm" aria-labelledby="confirm-title"><form method="dialog">
  <h2 id="confirm-title">Withdraw link?</h2><p id="confirm-help"></p><p role="alert" id="confirm-error" hidden></p>
  <div class="inline"><button type="button" class="button danger" id="confirm-action">Withdraw link</button><button class="button" value="cancel">Cancel</button></div></form></dialog>`

function recipient(page: 'share' | 'request') {
  const request = page === 'request'
  return `<section id="recipient" class="recipient" hidden aria-labelledby="recipient-title">
    <span class="stamp large">${icon(request ? 'upload' : 'file')}</span>
    <h1 id="recipient-title">${titles[page]}</h1><p id="recipient-description"></p>
    ${
      request
        ? picker()
        : `<div id="download-area" hidden>
    <a class="button primary" id="download">Download file</a></div>
    <form id="unlock" method="post" hidden><label for="unlock-password">Link password</label><input type="password" id="unlock-password" name="password" autocomplete="current-password" required>
    <button type="submit" class="button primary">Download file</button></form>`
    }</section>`
}

export function renderCloudPage(kind: Page, alias = ''): Response {
  const title = titles[kind]
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark"><meta name="referrer" content="same-origin"><link rel="icon" type="image/png" href="/assets/lshare-mark.png">
  <link rel="stylesheet" href="/assets/cloud.css"><title>${title} · lshare</title><script type="module" src="/assets/cloud.js"></script></head>
  <body data-page="${kind}" data-alias="${escape(alias)}"><a class="skip" href="#main">Skip to content</a><header><div class="bar">
  <a class="brand" href="/" aria-label="lshare home"><img src="/assets/lshare-mark.png" alt="" width="36" height="36"><span>lshare</span></a>
  <div id="account" hidden><span id="address"></span><button class="text" id="logout" type="button">Sign out</button></div></div></header>
  <main id="main" tabindex="-1"><div id="feedback" role="alert" hidden></div><button type="button" id="retry-open" class="button" hidden>Try again</button><p id="notice" class="notice" role="status"></p><p id="loading" role="status">Opening ${kind === 'home' ? 'your workspace' : title.toLowerCase()}…</p>
  ${verify}${kind === 'home' ? home : recipient(kind)}<noscript>Enable JavaScript to verify your email and use this file link.</noscript>
  </main></body></html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  )
}
