/** @jsxImportSource remix/component */
import type { Action, Entry, ResourceRef } from '../contracts'
import {
  appShell,
  csrfField,
  dateLabel,
  dialog,
  documentPage,
  empty,
  entryBadge,
  icon,
  refUrl,
  sizeLabel,
  type Shell,
  type MountView,
} from './base'

export type ShareView = {
  id: string
  alias: string
  kind: 'upload' | 'download'
  access: string
  mode: string
  enabled: boolean
  expiresAt?: number | string | null
  maxBytes?: number | null
  maxDownloads?: number | null
  ownerId?: string
  targets: ResourceRef[]
  broken?: boolean
  status?: string
}
export function shareEditor(csrf: string) {
  return dialog(
    'share-editor',
    'Share files',
    <form id="share-form" method="post" action="/_/api/v1/shares">
      {csrfField(csrf)}
      <p class="selection-summary" data-share-summary></p>
      <label>
        Link address
        <span class="input-prefix">
          <span>/</span>
          <input
            name="alias"
            maxlength={64}
            pattern="[a-z0-9][a-z0-9_\-]{0,63}"
            placeholder="Generate a random link"
            autocapitalize="none"
            spellcheck={false}
          />
        </span>
      </label>
      <div class="two-fields">
        <label>
          Access
          <select name="access">
            <option value="authenticated">Signed-in users</option>
            <option value="public">Anyone with the link</option>
            <option value="password">Password protected</option>
          </select>
        </label>
        <label data-mode-field>
          Open link as
          <select name="mode">
            <option value="direct">Direct download</option>
            <option value="landing">Download page</option>
          </select>
        </label>
      </div>
      <label data-password-field hidden>
        Share password
        <input
          name="password"
          type="password"
          autocomplete="new-password"
          minlength={8}
        />
      </label>
      <label class="check-note" data-public-warning hidden>
        <input type="checkbox" name="confirmPublic" />I confirm that anyone who
        knows or guesses this link can access the share.
      </label>
      <details class="options">
        <summary>Expiry and limits</summary>
        <div class="two-fields">
          <label>
            Expires at
            <input type="datetime-local" name="expiresAt" />
          </label>
          <label data-limit-field>
            Download limit
            <input
              type="number"
              min="1"
              name="maxDownloads"
              placeholder="Unlimited"
            />
          </label>
          <label data-cap-field hidden>
            Total upload limit (MiB)
            <input
              type="number"
              min="1"
              name="maxMiB"
              placeholder="Unlimited"
            />
          </label>
        </div>
      </details>
      <p role="alert" data-form-error hidden></p>
      <div class="dialog-actions">
        <button type="button" data-close>
          Cancel
        </button>
        <button type="submit" class="primary" data-share-submit>
          Create link
        </button>
      </div>
    </form>,
  )
}
export function shareResult() {
  return dialog(
    'share-result',
    'Your link is ready',
    <div>
      <label>
        Share URL
        <input type="url" readonly data-share-url />
      </label>
      <p data-copy-result aria-live="polite"></p>
      <div class="dialog-actions">
        <button type="button" data-close>
          Done
        </button>
        <button type="button" class="primary" data-copy-result-url>
          {icon('copy')}Copy link
        </button>
      </div>
    </div>,
  )
}
function operationsDialog() {
  return dialog(
    'operation',
    'File action',
    <form id="operation-form">
      <p data-operation-summary></p>
      <label data-name-field>
        Name
        <input name="name" maxlength={255} autocomplete="off" />
      </label>
      <div data-destination-field>
        <label>
          Destination storage<select name="mountId"></select>
        </label>
        <label>
          Destination folder
          <input name="path" placeholder="/" />
        </label>
      </div>
      <label data-conflict-field>
        If a file already exists
        <select name="conflict">
          <option value="reject">Stop and report</option>
          <option value="rename">Keep both</option>
          <option value="skip">Skip this item</option>
          <option value="overwrite">Replace existing file</option>
        </select>
      </label>
      <p role="alert" data-form-error hidden></p>
      <div class="dialog-actions">
        <button type="button" data-close>
          Cancel
        </button>
        <button class="primary" data-operation-submit type="submit">
          Apply
        </button>
      </div>
    </form>,
  )
}
export type FilesPage = Shell & {
  currentMount?: MountView
  ref: ResourceRef
  entries: Entry[]
  permissions?: Action[]
  error?: string
  query?: string
  scope?: string
  pagination?: { page: number; pages: number }
  space?: { free: number; total: number }
}
function action(
  name: string,
  title: string,
  iconName: Parameters<typeof icon>[0],
  display = '',
) {
  return (
    <button type="button" class={'file-action ' + display} data-action={name}>
      {icon(iconName, 16)}
      {title}
    </button>
  )
}
function breadcrumbs(page: FilesPage, mountLabel: string) {
  return (
    <nav aria-label="Breadcrumb" class="crumbs">
      <a href="/_/files">{icon('folder', 16)}All files</a>
      {icon('chevron', 12)}
      <a href={refUrl('/_/files', { mountId: page.ref.mountId, segments: [] })}>
        {mountLabel}
      </a>
      {page.ref.segments.map((part, i) => (
        <span>
          {icon('chevron', 12)}
          <a
            href={refUrl('/_/files', {
              mountId: page.ref.mountId,
              segments: page.ref.segments.slice(0, i + 1),
            })}
          >
            {part}
          </a>
        </span>
      ))}
    </nav>
  )
}
export function uploadInputs() {
  return (
    <>
      <input data-upload-files type="file" multiple hidden />
      <input data-upload-directory type="file" multiple hidden />
    </>
  )
}
export async function renderFiles(page: FilesPage) {
  const { pagination } = page
  const mount =
    page.currentMount ?? page.mounts.find((m) => m.id === page.ref.mountId)
  const label = mount?.label || 'Storage'
  const title = page.query
    ? 'Search results'
    : page.ref.segments.at(-1) || label
  const can = (action: Action) =>
    !page.error &&
    !!mount &&
    mount.available !== false &&
    (page.permissions?.includes(action) ?? true)
  const canUpload = can('upload') && !mount?.readOnly
  const tools = (
    <>
      {can('create') && !mount?.readOnly ? (
        <button data-action="createDir">{icon('plus')}New folder</button>
      ) : null}
      {canUpload ? (
        <button class="primary" data-upload-button>
          {icon('upload')}Upload files
        </button>
      ) : null}
    </>
  )
  const fileContents = (
    <section
      id="file-manager"
      data-ref={JSON.stringify(page.ref)}
      data-mounts={JSON.stringify(
        (mount && !page.mounts.some((m) => m.id === mount.id)
          ? [...page.mounts, mount]
          : page.mounts
        ).map(({ id, label, readOnly }) => ({ id, label, readOnly })),
      )}
      data-upload-url={canUpload ? '/_/uploads' : undefined}
    >
      <div class="folder-summary">
        <span>
          {page.ref.segments.length
            ? 'Folder'
            : mount?.readOnly
              ? 'Read-only storage'
              : 'Storage'}
        </span>
        {page.error ? null : (
          <>
            <span class="separator">/</span>
            <span>
              {page.entries.length.toLocaleString()}{' '}
              {page.entries.length === 1 ? 'item' : 'items'}
              {pagination && pagination.pages > 1 ? ' on this page' : ''}
            </span>
          </>
        )}
        {page.space ? (
          <>
            <span class="separator">/</span>
            <span>{sizeLabel(page.space.free)} free</span>
          </>
        ) : null}
      </div>
      {page.error ? (
        <div role="alert">
          {empty('Storage unavailable', page.error, 'storage')}
        </div>
      ) : (
        <>
          <div class="file-controls">
            <form method="get" action="/_/files" class="search-form">
              <input type="hidden" name="mount" value={page.ref.mountId} />
              <input
                type="hidden"
                name="path"
                value={page.ref.segments.join('/')}
              />
              <label class="search-input">
                {icon('search', 17)}
                <input
                  type="search"
                  name="q"
                  value={page.query || ''}
                  placeholder="Search files"
                  aria-label="Search files"
                />
              </label>
              <select name="scope" aria-label="Search scope">
                <option value="folder" selected={page.scope !== 'tree'}>
                  This folder
                </option>
                <option value="tree" selected={page.scope === 'tree'}>
                  Subfolders
                </option>
              </select>
              <button class="icon-btn" aria-label="Run search">
                {icon('arrow', 16)}
              </button>
            </form>
            <div class="view-tools">
              <button
                type="button"
                class="icon-btn"
                data-refresh
                title="Refresh files"
                aria-label="Refresh files"
              >
                {icon('refresh', 16)}
              </button>
              <div class="switcher">
                <button
                  type="button"
                  data-view="list"
                  class="icon-btn"
                  aria-pressed="true"
                  aria-label="List view"
                >
                  {icon('list', 17)}
                </button>
                <button
                  type="button"
                  data-view="grid"
                  class="icon-btn"
                  aria-pressed="false"
                  aria-label="Grid view"
                >
                  {icon('grid', 16)}
                </button>
              </div>
            </div>
          </div>
          <div class="selection-tools" data-selection-tools hidden>
            <strong data-selection-count></strong>
            {action('share', 'Share', 'share')}
            {action('bulkRename', 'Rename items', 'file')}
            {action('archive', 'Download archive', 'archive')}
            {action('copy', 'Copy to', 'copy')}
            {action('move', 'Move to', 'folder')}
            {action('trash', 'Trash', 'trash')}
            <button type="button" data-clear-selection>
              Clear
            </button>
          </div>
          <div class="file-table" data-list>
            {page.entries.length ? (
              <div class="file-head">
                <label>
                  <input
                    type="checkbox"
                    aria-label="Select all visible files"
                    id="select-all"
                  />
                </label>
                <button type="button" data-sort="name">
                  Name {icon('down', 12)}
                </button>
                <button type="button" data-sort="size">
                  Size
                </button>
                <button type="button" data-sort="date">
                  Modified
                </button>
                <span></span>
              </div>
            ) : null}
            <div class="file-rows" data-file-rows>
              {page.entries.map((entry) => {
                const href = refUrl(
                  entry.kind === 'directory' ? '/_/files' : '/_/preview',
                  entry.ref,
                )
                return (
                  <div
                    class="file-row"
                    data-entry={JSON.stringify({
                      ref: entry.ref,
                      name: entry.name,
                      kind: entry.kind,
                      size: entry.size,
                      modifiedAt: entry.modifiedAt,
                      permissions: entry.permissions,
                    })}
                    draggable="true"
                  >
                    <label class="row-select">
                      <input
                        type="checkbox"
                        aria-label={'Select ' + entry.name}
                        data-select
                      />
                    </label>
                    <a
                      class="entry-name"
                      href={href}
                      data-directory={
                        entry.kind === 'directory' ? 'true' : undefined
                      }
                      data-preview={entry.kind === 'file' ? 'true' : undefined}
                    >
                      {entryBadge(entry.name, entry.kind === 'directory')}
                      <span>{entry.name}</span>
                    </a>
                    <span class="entry-size">
                      {entry.kind === 'directory' ? '—' : sizeLabel(entry.size)}
                    </span>
                    <time datetime={entry.modifiedAt}>
                      {dateLabel(entry.modifiedAt)}
                    </time>
                    <button
                      type="button"
                      class="icon-btn"
                      data-row-menu
                      aria-label={'Actions for ' + entry.name}
                      aria-haspopup="dialog"
                    >
                      {icon('dots')}
                    </button>
                  </div>
                )
              })}
            </div>
            {page.entries.length === 0
              ? empty(
                  page.query ? 'No matching files' : 'This folder is empty',
                  page.query
                    ? 'Try another filename or search the subfolders.'
                    : can('upload') && !mount?.readOnly
                      ? 'Upload files or create a folder to get started.'
                      : 'Files added to this folder will appear here.',
                  page.query ? 'search' : 'folder',
                )
              : null}
          </div>
          {pagination && pagination.pages > 1 ? (
            <nav class="paging" aria-label="File pages">
              {[-1, 1].map((step) => {
                const p = pagination.page + step
                const url = new URL(
                  refUrl('/_/files', page.ref),
                  'http://local',
                )
                url.searchParams.set('page', String(p))
                if (page.query) url.searchParams.set('q', page.query)
                if (page.scope) url.searchParams.set('scope', page.scope)
                return p >= 1 && p <= pagination.pages ? (
                  <a href={url.pathname + url.search}>
                    {step === -1 ? 'Previous' : 'Next'}
                  </a>
                ) : null
              })}
              <span>
                Page {pagination.page} of {pagination.pages}
              </span>
            </nav>
          ) : null}
          <div class="folder-actions">
            {canUpload ? (
              <button
                class="text-button"
                type="button"
                data-folder-upload-button
              >
                {icon('upload', 15)}Upload folder
              </button>
            ) : null}
            {can('share') && can('upload') && !mount?.readOnly ? (
              <button class="text-button" type="button" data-action="request">
                {icon('share', 15)}Request uploads here
              </button>
            ) : null}
          </div>
        </>
      )}
      {canUpload ? uploadInputs() : null}
      {dialog(
        'file-actions',
        'File actions',
        <div class="action-menu">
          <p data-file-context></p>
          {action('open', 'Open', 'folder')}
          {action('download', 'Download', 'download')}
          {action('share', 'Create share link', 'share')}
          {action('request', 'Request uploads', 'upload')}
          {action('favorite', 'Toggle favorite', 'star')}
          {action('rename', 'Rename', 'file')}
          {action('archive', 'Download archive', 'archive')}
          {action('copy', 'Copy to', 'copy')}
          {action('move', 'Move to', 'folder')}
          {action('trash', 'Move to trash', 'trash')}
          {action('details', 'Details', 'info')}
        </div>,
      )}
      {dialog(
        'preview',
        'Preview',
        <div>
          <h3 data-preview-title></h3>
          <div data-preview-body></div>
          <nav class="gallery-nav" aria-label="Preview navigation">
            <button type="button" data-adjacent="-1">
              Previous
            </button>
            <button type="button" data-adjacent="1">
              Next
            </button>
          </nav>
          <a
            class="button"
            data-formatted-preview
            hidden
            target="_blank"
            rel="noopener"
            data-rmx-document
          >
            Open formatted preview
          </a>
          <div class="dialog-actions">
            <a
              class="button primary"
              data-preview-download
              download
              data-rmx-document
            >
              Download
            </a>
          </div>
        </div>,
      )}
      {dialog(
        'details',
        'File details',
        <dl class="details-list" data-details></dl>,
      )}
      {dialog(
        'bulk-rename',
        'Rename selected items',
        <form id="bulk-rename-form">
          <div data-bulk-names></div>
          <p role="alert" data-form-error hidden></p>
          <div class="dialog-actions">
            <button data-close type="button">
              Cancel
            </button>
            <button class="primary" type="submit">
              Rename items
            </button>
          </div>
        </form>,
      )}
      {operationsDialog()}
      {shareEditor(page.csrf)}
      {shareResult()}
    </section>
  )
  return documentPage(
    title,
    appShell(
      page,
      'files',
      title,
      fileContents,
      tools,
      breadcrumbs(page, label),
    ),
    page.csrf,
    200,
    page.brand,
  )
}
export async function renderShares(page: Shell & { shares: ShareView[] }) {
  const body = (
    <section>
      <p class="folder-summary">
        {page.shares.length} {page.shares.length === 1 ? 'link' : 'links'}
      </p>
      {page.shares.length ? (
        <div class="records">
          <div class="batch-share-tools" hidden>
            <span data-share-total></span>
            <button data-share-batch="disable">Disable selected</button>
            <button data-share-batch="revoke">Revoke selected</button>
          </div>
          {page.shares.map((s) => (
            <article
              data-share-record={JSON.stringify({
                id: s.id,
                alias: s.alias,
                enabled: s.enabled,
                targets: s.targets,
                access: s.access,
                mode: s.mode,
                kind: s.kind,
                expiresAt: s.expiresAt,
                maxBytes: s.maxBytes,
                maxDownloads: s.maxDownloads,
              })}
            >
              <input
                type="checkbox"
                data-share-select
                value={s.id}
                aria-label={'Select /' + s.alias}
              />
              <div class="record-icon">
                {icon(s.kind === 'upload' ? 'upload' : 'share')}
              </div>
              <div class="record-name">
                <strong>/{s.alias}</strong>
                <small>
                  {s.kind === 'upload' ? 'Upload request' : 'Download'} ·{' '}
                  {s.access} ·{' '}
                  {s.status ||
                    (s.broken
                      ? 'Broken'
                      : !s.enabled
                        ? 'Disabled'
                        : s.expiresAt &&
                            new Date(s.expiresAt).getTime() <= Date.now()
                          ? 'Expired'
                          : 'Active')}
                </small>
              </div>
              <div class="record-actions">
                <button type="button" data-copy-share>
                  {icon('copy', 15)}Copy link
                </button>
                <button type="button" data-share-history>
                  History
                </button>
                <button type="button" data-edit-share>
                  Edit
                </button>
                <button type="button" data-toggle-share>
                  {s.enabled ? 'Disable' : 'Enable'}
                </button>
                <button class="danger-text" type="button" data-revoke-share>
                  Revoke
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        empty(
          'No shared links yet',
          'Open a file’s actions and choose Create share link to send it to someone.',
          'share',
        )
      )}
      {shareEditor(page.csrf)}
      {shareResult()}
      {dialog('share-history', 'Link history', <div data-history-list></div>)}
      {confirmDialog()}
    </section>
  )
  return documentPage(
    'Shared links',
    appShell(page, 'shares', 'Shared links', body),
    page.csrf,
    200,
    page.brand,
  )
}
export function confirmDialog() {
  return dialog(
    'confirmation',
    'Confirm action',
    <form method="dialog">
      <p data-confirm-text></p>
      <div class="dialog-actions">
        <button value="cancel">Cancel</button>
        <button value="confirm" class="danger-button">
          Confirm
        </button>
      </div>
    </form>,
  )
}
type TrashView = {
  id: string
  ref?: ResourceRef
  original?: ResourceRef
  name?: string
  deletedAt?: string | number
  originalPath?: string
}
export async function renderTrash(page: Shell & { items: TrashView[] }) {
  const body = page.items.length ? (
    <div class="records">
      {page.items.map((item) => {
        const ref = item.ref || item.original
        const name = item.name || ref?.segments.at(-1) || 'Deleted item'
        return (
          <article>
            {entryBadge(name)}
            <div class="record-name">
              <strong>{name}</strong>
              <small>
                {ref ? '/' + ref.segments.join('/') : item.originalPath || ''}
                {item.deletedAt ? ' · ' + dateLabel(item.deletedAt) : ''}
              </small>
            </div>
            <button data-trash-id={item.id} data-trash-op="restore">
              Restore
            </button>
            <button
              data-trash-id={item.id}
              data-trash-op="purge"
              class="danger-text"
            >
              Delete permanently
            </button>
          </article>
        )
      })}
    </div>
  ) : (
    empty(
      'Trash is empty',
      'Items moved to trash can be restored here.',
      'trash',
    )
  )
  return documentPage(
    'Trash',
    appShell(
      page,
      'trash',
      'Trash',
      <>
        {body}
        {confirmDialog()}
      </>,
    ),
    page.csrf,
    200,
    page.brand,
  )
}
