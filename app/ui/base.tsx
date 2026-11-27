/** @jsxImportSource remix/component */
import type { RemixNode } from 'remix/component'
import { renderToString } from 'remix/component/server'
import type { ResourceRef, User } from '../contracts'

export type MountView = {
  id: string
  label: string
  readOnly?: boolean
  available?: boolean
}
export type Shell = {
  user: User
  csrf: string
  mounts: MountView[]
  home?: ResourceRef | null
  brand?: string
}
export type Nav = 'files' | 'shares' | 'trash' | 'admin' | 'account'
const paths = {
  folder:
    'M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  file: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 13h6 M9 16h4',
  image: 'M3 4h18v16H3z M4 17l5-5 4 4 3-3 4 4 M15 8h.01',
  music:
    'M8 18V6l11-2v12 M8 17c-4-2-7 3-3 4 2 .5 3-1 3-3 M19 15c-4-2-7 3-3 4 2 .5 3-1 3-3',
  film: 'M3 5h18v14H3z M3 9h18 M7 5l3 4 M14 5l3 4 M10 12l4 2-4 2z',
  archive: 'M3 4h18v5H3z M5 9v11h14V9 M9 13h6',
  code: 'm8 7-5 5 5 5 M16 7l5 5-5 5 M14 4l-4 16',
  storage: 'M4 6h16l2 12H2z M4 14h16 M16 16h2',
  share:
    'M10 13a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-2 2 M14 11a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l2-2',
  trash: 'M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
  user: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 6 0 0 1 16 0v2',
  settings: 'M3 6h5m4 0h9 M3 12h10m4 0h4 M3 18h2m4 0h12 M8 3v6 M14 9v6 M6 15v6',
  search: 'M16.5 10a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0 M15 15l6 6',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 16v4h16v-4',
  download: 'M12 3v13 M7 11l5 5 5-5 M4 16v4h16v-4',
  plus: 'M12 5v14 M5 12h14',
  menu: 'M3 6h18 M3 12h18 M3 18h18',
  dots: 'M4 12h1 M11 12h1 M18 12h1',
  arrow: 'M4 12h15 M13 6l6 6-6 6',
  chevron: 'm9 5 7 7-7 7',
  down: 'm5 9 7 7 7-7',
  close: 'm6 6 12 12 M18 6 6 18',
  list: 'M4 6h2m3 0h11 M4 12h2m3 0h11 M4 18h2m3 0h11',
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  refresh:
    'M20 10a8 8 0 0 0-14-5L3 8 M3 3v5h5 M4 14a8 8 0 0 0 14 5l3-3 M21 21v-5h-5',
  transfer: 'M6 3v16m-4-4 4 4 4-4 M18 21V5m-4 4 4-4 4 4',
  copy: 'M8 8h12v13H8z M4 16H3V3h12v1',
  star: 'm12 3 3 6 6 1-4.5 4.7 1 6.3-5.5-3-5.5 3 1-6.3L3 10l6-1z',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 6v6l4 2',
  info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 11v5 M12 7h.01',
  exit: 'M10 4H4v16h6 M9 12h12m-5-5 5 5-5 5',
  lock: 'M5 10h14v11H5z M8 10V7a4 4 0 0 1 8 0v3',
} as const
export type Glyph = keyof typeof paths
export function icon(name: Glyph, size = 18) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.65"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  )
}
export function brandmark() {
  return (
    <svg
      class="brandmark"
      width="31"
      height="31"
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <rect width="32" height="32" rx="7" fill="currentColor" />
      <path
        d="M7 9h8l3 3h7v3H7zm0 8h18v3H7zm0 5h13v2H7z"
        fill="var(--canvas)"
      />
    </svg>
  )
}
export function sizeLabel(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value < 1024) return value + ' B'
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0,
    size = value / 1024
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  return (
    size.toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' ' + units[i]
  )
}
export function dateLabel(value: string | number) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}
export function refUrl(path: string, ref: ResourceRef) {
  const search = new URLSearchParams({
    mount: ref.mountId,
    path: ref.segments.join('/'),
  })
  return path + '?' + search
}
export function fileGlyph(name: string, directory = false): Glyph {
  if (directory) return 'folder'
  const ext = name.split('.').at(-1)?.toLowerCase()
  if (
    ext &&
    [
      'jpg',
      'jpeg',
      'png',
      'gif',
      'webp',
      'bmp',
      'avif',
      'heic',
      'svg',
    ].includes(ext)
  )
    return 'image'
  if (ext && ['mp4', 'webm', 'mov', 'mkv'].includes(ext)) return 'film'
  if (ext && ['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(ext)) return 'music'
  if (ext && ['zip', 'gz', 'tar', '7z'].includes(ext)) return 'archive'
  if (ext && ['ts', 'js', 'json', 'html', 'css', 'sh', 'py'].includes(ext))
    return 'code'
  return 'file'
}
export function csrfField(value: string) {
  return <input type="hidden" name="csrf" value={value} />
}
export async function documentPage(
  title: string,
  body: RemixNode,
  csrf = '',
  status = 200,
  brand = 'Fileserver',
) {
  const html = await renderToString(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="csrf-token" content={csrf} />
        <title>{title + ' · ' + brand}</title>
        <link rel="icon" href="/assets/mark.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/assets/files.css" />
        <script type="module" src="/assets/files.js"></script>
      </head>
      <body>
        {body}
        <div id="live-message" role="status" aria-live="polite"></div>
      </body>
    </html>,
  )
  return new Response(html.startsWith('<!') ? html : '<!doctype html>' + html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
const sections = [
  ['files', 'folder', 'All files', '/_/files'],
  ['shares', 'share', 'Shared links', '/_/shares'],
  ['trash', 'trash', 'Trash', '/_/trash'],
] as const
export function appShell(
  shell: Shell,
  current: Nav,
  heading: string,
  content: RemixNode,
  tools?: RemixNode,
  crumb?: RemixNode,
) {
  const root = shell.brand || 'Fileserver'
  return (
    <div class="app" data-account={shell.user.id}>
      <a class="skip" href="#workspace">
        Skip to workspace
      </a>
      <aside class="rail" id="navigation" aria-label="Sidebar">
        <a href="/_/files" class="brand">
          {brandmark()}
          <span>{root}</span>
        </a>
        <nav aria-label="Workspace">
          <span class="section-title">Workspace</span>
          {sections.map(([id, glyph, label, href]) => (
            <a
              href={href}
              class={'nav-item' + (current === id ? ' current' : '')}
              aria-current={current === id ? 'page' : undefined}
            >
              {icon(glyph)}
              {label}
            </a>
          ))}
          <button class="nav-item" type="button" data-open="transfers">
            {icon('transfer')}Transfers
            <span class="count" data-queue-count hidden></span>
          </button>
          <button class="nav-item" type="button" data-open="favorites">
            {icon('star')}Favorites
          </button>
          <button class="nav-item" type="button" data-open="recent">
            {icon('clock')}Recent
          </button>
        </nav>
        <nav aria-label="Storage">
          <span class="section-title">Storage</span>
          {shell.home ? (
            <a class="nav-item" href={refUrl('/_/files', shell.home)}>
              {icon('lock')}Private home
            </a>
          ) : null}
          {shell.mounts.map((m) => (
            <a
              href={refUrl('/_/files', { mountId: m.id, segments: [] })}
              class="nav-item"
            >
              {icon('storage')}
              <span>{m.label}</span>
              {m.available === false ? (
                <span class="warning-dot" title="Unavailable"></span>
              ) : null}
            </a>
          ))}
        </nav>
        <div class="rail-foot">
          {shell.user.admin ? (
            <a
              class={'nav-item' + (current === 'admin' ? ' current' : '')}
              href="/_/admin"
            >
              {icon('settings')}Administration
            </a>
          ) : null}
          <a href="/_/account" class="account">
            <span class="avatar">
              {shell.user.username.slice(0, 2).toUpperCase()}
            </span>
            <span>
              <strong>{shell.user.username}</strong>
              <small>
                {shell.user.admin ? 'Administrator' : 'Account settings'}
              </small>
            </span>
            {icon('chevron', 14)}
          </a>
        </div>
      </aside>
      <div class="work">
        <header class="topbar">
          <button
            class="icon-btn nav-toggle"
            data-navigation
            aria-label="Toggle navigation"
            aria-controls="navigation"
            aria-expanded="false"
          >
            {icon('menu')}
          </button>
          <div class="breadcrumbs">{crumb || <span>{heading}</span>}</div>
          <div class="bar-end">
            <button
              class="icon-btn"
              type="button"
              data-open="preferences"
              title="Display preferences"
              aria-label="Display preferences"
            >
              {icon('settings')}
            </button>
          </div>
        </header>
        <main id="workspace" tabindex={-1}>
          <div class="page-heading">
            <h1>{heading}</h1>
            {tools ? <div class="actions">{tools}</div> : null}
          </div>
          {content}
        </main>
      </div>
      {dialog(
        'transfers',
        'Transfers',
        <div data-transfer-list>
          <p class="quiet">No transfers in this session.</p>
        </div>,
      )}
      {dialog(
        'favorites',
        'Favorites',
        <div data-saved-list="favorites"></div>,
      )}
      {dialog(
        'recent',
        'Recently opened',
        <div data-saved-list="recent"></div>,
      )}
      {dialog(
        'preferences',
        'Display preferences',
        <div class="preferences-form">
          <label>
            Appearance
            <select data-theme-picker>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label>
            Sort files by
            <select data-sort-picker>
              <option value="name">Name</option>
              <option value="name-desc">Name (descending)</option>
              <option value="type">Type</option>
              <option value="size">Size</option>
              <option value="size-desc">Size (largest first)</option>
              <option value="mtime-desc">Recently modified</option>
            </select>
          </label>
          <label>
            When uploads have the same name
            <select data-upload-conflict>
              <option value="reject">Stop and report</option>
              <option value="rename">Keep both</option>
              <option value="skip">Skip</option>
              <option value="overwrite">Replace existing file</option>
            </select>
          </label>
        </div>,
      )}
    </div>
  )
}
export function dialog(id: string, label: string, content: RemixNode) {
  return (
    <dialog id={id} aria-labelledby={id + '-title'}>
      <header class="dialog-head">
        <h2 id={id + '-title'}>{label}</h2>
        <button
          class="icon-btn"
          type="button"
          data-close
          aria-label={'Close ' + label}
        >
          {icon('close')}
        </button>
      </header>
      {content}
    </dialog>
  )
}
export function empty(title: string, message: string, glyph: Glyph = 'folder') {
  return (
    <div class="empty">
      <span class="empty-icon">{icon(glyph, 36)}</span>
      <h2>{title}</h2>
      <p>{message}</p>
    </div>
  )
}
export function entryBadge(name: string, directory = false, large = false) {
  const glyph = fileGlyph(name, directory)
  return (
    <span
      aria-hidden="true"
      class={'entry-icon ' + glyph + (large ? ' large' : '')}
    >
      {icon(glyph, large ? 30 : 20)}
    </span>
  )
}
export function signedOut(brand: string, body: RemixNode) {
  return (
    <div class="public-shell">
      <header class="public-bar">
        <a class="brand" href="/">
          {brandmark()}
          <span>{brand}</span>
        </a>
      </header>
      <main id="workspace" class="public-main">
        {body}
      </main>
    </div>
  )
}
