/** @jsxImportSource remix/component */
import {
  csrfField,
  documentPage,
  entryBadge,
  icon,
  signedOut,
  sizeLabel,
} from './base'
import { uploadInputs } from './files'
import { PasswordField } from './login-client'

export * from './files'
export * from './account'
export { buildUiAssets } from './assets'

function illustration() {
  return (
    <svg
      class="folder-illustration"
      viewBox="0 0 440 330"
      aria-hidden="true"
      fill="none"
    >
      <defs>
        <pattern
          id="paper-dots"
          width="9"
          height="9"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r=".85" fill="#789888" />
        </pattern>
      </defs>
      <path fill="url(#paper-dots)" d="M0 0h440v330H0z" />
      <g stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6">
        <path
          fill="#264c40"
          stroke="#aac4a7"
          d="m68 109 109-32 29 10 105-30 55 23-5 141-217 62-33-12z"
        />
        <path
          fill="#daead4"
          stroke="#283e33"
          d="m88 111 204-59 47 20-201 61z"
        />
        <path
          fill="#bacfb1"
          stroke="#283e33"
          d="m105 121 205-60 32 14-205 60z"
        />
        <path
          fill="#eff0d8"
          stroke="#283e33"
          d="m115 131 205-60 29 13-204 60z"
        />
        <path
          fill="#acc5a0"
          stroke="#283e33"
          d="m125 147 206-61 17 8-203 61z"
        />
        <path
          fill="#9fbc94"
          stroke="#c8dbc1"
          d="m107 145 33 8 9 115-16 8-31-136z"
        />
        <path
          fill="#b7d7aa"
          stroke="#d3e7cc"
          d="m134 154 73-21 13-14 139-40-11 143-200 59z"
        />
        <path stroke="#70936a" d="m157 256 173-51m-173 57 173-51" />
        <path fill="#496b4e" stroke="none" d="m160 183 68-20-.6 7-67 20z" />
        <path fill="#83a77a" stroke="none" d="m160 196 39-11-.4 4-39 11z" />
      </g>
    </svg>
  )
}
export async function renderLogin({
  csrf,
  error,
  next,
  brand = 'Fileserver',
}: {
  csrf: string
  error?: string
  next?: string
  brand?: string
}) {
  return documentPage(
    'Sign in',
    signedOut(
      brand,
      <div class="auth-layout">
        <section class="auth-card">
          <div class="auth-mark">{icon('lock', 24)}</div>
          <h1>Sign in</h1>
          <p>Access your files and shared folders.</p>
          <form action="/login" method="post" data-rmx-document>
            {csrfField(csrf)}
            {next ? <input type="hidden" name="next" value={next} /> : null}
            <label>
              Username
              <input
                name="username"
                required
                autocomplete="username"
                autocapitalize="none"
                spellcheck={false}
              />
            </label>
            <PasswordField />
            {error ? (
              <p class="error" role="alert">
                {error}
              </p>
            ) : null}
            <button class="primary" type="submit">
              Sign in {icon('arrow', 17)}
            </button>
          </form>
          <div class="auth-help">
            {icon('share', 16)}
            <p>
              Have a share link? Open it directly to access the shared files.
            </p>
          </div>
        </section>
        <aside class="auth-art" aria-hidden="true">
          {illustration()}
        </aside>
        <script type="module" src="/assets/hydrate-login.js"></script>
      </div>,
    ),
    csrf,
    error ? 401 : 200,
    brand,
  )
}
export type PublicSharePage = {
  kind: 'unlock' | 'file' | 'directory' | 'selection' | 'upload'
  title: string
  csrf: string
  alias: string
  id: string
  brand?: string
  size?: number
  downloadUrl?: string
  unlockUrl?: string
  returnTo?: string
  entries?: {
    name: string
    href: string
    kind: 'file' | 'directory'
    size?: number | null
  }[]
  parentUrl?: string
  uploadUrl?: string
  error?: string
  status?: number
}
export async function renderPublicShare(p: PublicSharePage) {
  const brand = p.brand || 'Fileserver'
  const grant = p.kind === 'unlock',
    upload = p.kind === 'upload',
    collection = p.kind === 'selection' || p.kind === 'directory'
  const body = (
    <section
      class="share-card"
      data-upload-url={p.uploadUrl}
      data-share-id={p.id}
    >
      <span class="share-marker">
        {icon(grant ? 'lock' : upload ? 'upload' : 'share', 16)}
        {grant ? 'Protected link' : upload ? 'File request' : 'Shared with you'}
      </span>
      {p.kind === 'file' ? entryBadge(p.title, false, true) : null}
      <h1>{p.title}</h1>
      {p.error ? (
        <p role="alert" class="error">
          {p.error}
        </p>
      ) : null}
      {grant ? (
        <form method="post" action={p.unlockUrl}>
          {csrfField(p.csrf)}
          <input
            type="hidden"
            name="returnTo"
            value={p.returnTo || '/' + p.alias}
          />
          <label>
            Share password
            <input
              type="password"
              required
              name="password"
              autocomplete="current-password"
            />
          </label>
          <button class="primary" type="submit">
            {icon('lock', 16)}Unlock share
          </button>
        </form>
      ) : null}
      {p.kind === 'file' && p.downloadUrl ? (
        <>
          <p>{sizeLabel(p.size)} · File download</p>
          <a
            class="button primary"
            href={p.downloadUrl}
            download
            data-rmx-document
          >
            {icon('download')}Download
          </a>
        </>
      ) : null}
      {collection ? (
        <>
          {p.parentUrl ? (
            <a class="back-link" href={p.parentUrl}>
              Parent folder
            </a>
          ) : null}
          <p>
            {p.entries?.length || 0}{' '}
            {p.entries?.length === 1 ? 'item' : 'items'}
          </p>
          {p.entries?.length ? (
            <ul class="shared-entries">
              {p.entries.map((e) => (
                <li>
                  <a
                    href={e.href}
                    download={e.kind === 'file' ? true : undefined}
                    data-rmx-document
                  >
                    {entryBadge(e.name, e.kind === 'directory')}
                    <span>{e.name}</span>
                    <small>
                      {e.kind === 'file' ? sizeLabel(e.size) : 'Folder'}
                    </small>
                    {icon(e.kind === 'file' ? 'download' : 'chevron', 15)}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          {p.downloadUrl ? (
            <a class="button" href={p.downloadUrl} download data-rmx-document>
              {icon('archive')}Download archive
            </a>
          ) : null}
        </>
      ) : null}
      {upload ? (
        <>
          <p>
            Choose the files you want to send. Only the owner can see files in
            this folder.
          </p>
          <div class="upload-drop" data-drop-target>
            {icon('upload', 32)}
            <strong>Drop files here</strong>
            <div class="actions">
              <button class="primary" data-upload-button>
                Choose files
              </button>
              <button data-folder-upload-button>Choose folder</button>
            </div>
          </div>
          {uploadInputs()}
          <div class="inline-transfers" data-transfer-list></div>
        </>
      ) : null}
    </section>
  )
  return documentPage(
    p.title,
    signedOut(brand, body),
    p.csrf,
    p.status || 200,
    brand,
  )
}
export async function renderError({
  status,
  message,
  brand = 'Fileserver',
}: {
  status: number
  message: string
  brand?: string
}) {
  return documentPage(
    'Request unavailable',
    signedOut(
      brand,
      <section class="share-card">
        <span class="share-marker">
          {icon('info')}
          {status}
        </span>
        <h1>{status === 404 ? 'Link unavailable' : 'Request unavailable'}</h1>
        <p>{message}</p>
        <a href="/" class="button">
          Return to start
        </a>
      </section>,
    ),
    '',
    status,
    brand,
  )
}
