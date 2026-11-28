/** @jsxImportSource remix/component */
import {
  csrfField,
  documentPage,
  entryBadge,
  icon,
  signedOut,
  sizeLabel,
} from './base'
import { defaultBrand } from '../contracts'
import { archiveFormats } from '../archive-formats'
import { uploadInputs } from './files'
import { PasswordField } from './login-client'

export * from './files'
export * from './account'
export { buildUiAssets } from './assets'

export async function renderLogin({
  csrf,
  error,
  oidc,
  providerError,
  next,
  brand = defaultBrand,
}: {
  csrf: string
  error?: string
  oidc?: boolean
  providerError?: boolean
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
                aria-invalid={error && !providerError ? true : undefined}
                aria-describedby={
                  error && !providerError ? 'login-error' : undefined
                }
                required
                autocomplete="username"
                autocapitalize="none"
                spellcheck={false}
              />
            </label>
            <PasswordField invalid={Boolean(error && !providerError)} />
            {error ? (
              <p id="login-error" class="error" role="alert">
                {error}
              </p>
            ) : null}
            <button class="primary" type="submit">
              Sign in {icon('arrow', 17)}
            </button>
          </form>
          {oidc ? (
            <form action="/_/auth/oidc" method="post" data-rmx-document>
              {csrfField(csrf)}
              {next ? <input type="hidden" name="next" value={next} /> : null}
              <button type="submit">Continue with identity provider</button>
            </form>
          ) : null}
          <div class="auth-help">
            {icon('share', 16)}
            <p>
              Have a share link? Open it directly to access the shared files.
            </p>
          </div>
        </section>
        <aside class="auth-art" aria-hidden="true" />
        <script type="module" src="/assets/hydrate-login.js"></script>
      </div>,
    ),
    csrf,
    error ? 401 : 200,
    brand,
  )
}
export async function renderProviderRedirect(location: string, brand: string) {
  const page = await documentPage(
    'Continue to your identity provider',
    signedOut(
      brand,
      <p>
        <a href={location}>Continue to your identity provider</a>
      </p>,
    ),
    '',
    200,
    brand,
  )
  // Navigate as a document so the local form can retain its same-origin form-action policy.
  page.headers.set('Refresh', '0; url=' + location)
  page.headers.set('Referrer-Policy', 'no-referrer')
  return page
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
  const brand = p.brand || defaultBrand
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
      {p.kind === 'file' ? (
        <div class="shared-file">
          {entryBadge(p.title, false, true)}
          <div>
            <h1>{p.title}</h1>
            <p>{sizeLabel(p.size)} · File download</p>
          </div>
        </div>
      ) : (
        <h1>{p.title}</h1>
      )}
      {p.error ? (
        <p id="share-error" role="alert" class="error">
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
              aria-invalid={p.error ? true : undefined}
              aria-describedby={p.error ? 'share-error' : undefined}
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
            <div class="actions">
              {archiveFormats.map((format) => (
                <a
                  class="button"
                  href={p.downloadUrl + '&format=' + format.extension}
                  download
                  data-rmx-document
                >
                  {icon('archive')}
                  {format.label}
                </a>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {upload ? (
        <>
          <p>
            Choose files or a folder to send. This upload link keeps the
            folder’s contents private.
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
  brand = defaultBrand,
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
