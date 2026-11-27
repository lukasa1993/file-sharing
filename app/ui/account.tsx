/** @jsxImportSource remix/component */
import type { RemixNode } from 'remix/component'
import {
  contentLimitFields,
  type ContentLimits,
} from '../transfers/content-limits.ts'
import type { AppConfig } from '../contracts.ts'
import {
  appShell,
  csrfField,
  dateLabel,
  dialog,
  documentPage,
  icon,
  sizeLabel,
  type Shell,
} from './base'
import { confirmDialog } from './files'

type DataRow = Record<string, unknown>
function rows(data: unknown, key: string): DataRow[] {
  if (!data || typeof data !== 'object') return []
  const values = Reflect.get(data, key)
  return Array.isArray(values)
    ? values.filter((v): v is DataRow => typeof v === 'object' && v !== null)
    : []
}
function str(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : ''
}
function device(session: DataRow) {
  const label = str(session.device) || 'Unknown device'
  return session.current ? label + ' (this session)' : label
}

function settingsForm(
  csrf: string,
  endpoint: string,
  action: string,
  title: string,
  fields: RemixNode,
  button: string,
) {
  return (
    <details class="setting-form">
      <summary>
        {title}
        {icon('down', 15)}
      </summary>
      <form
        method="post"
        action={endpoint === admin ? '/_/admin' : '/_/account'}
        aria-label={title}
        data-json-form
        data-endpoint={endpoint}
      >
        {csrfField(csrf)}
        <input type="hidden" name="action" value={action} />
        {fields}
        <p data-form-error role="alert" hidden></p>
        <button type="submit">{button}</button>
      </form>
    </details>
  )
}
function input(
  label: string,
  name: string,
  type: 'text' | 'number' | 'password' = 'text',
  required = true,
) {
  const props = { name, required }
  const field =
    type === 'password' ? (
      <input {...props} type="password" autocomplete="new-password" />
    ) : type === 'number' ? (
      <input {...props} type="number" />
    ) : (
      <input {...props} type="text" autocomplete="off" />
    )
  return (
    <label>
      {label}
      {field}
    </label>
  )
}
function options(
  label: string,
  name: string,
  values: { value: string; label: string }[],
) {
  return (
    <label>
      {label}
      <select name={name} required>
        {values.map((v) => (
          <option value={v.value}>{v.label}</option>
        ))}
      </select>
    </label>
  )
}
function quotaLabel(used: number, reserved: number, quota: number | null) {
  const allowance = quota === null ? 'unlimited' : sizeLabel(quota)
  const remaining = reserved ? ' · ' + sizeLabel(reserved) + ' reserved' : ''
  return sizeLabel(used) + ' used of ' + allowance + remaining
}

function table(title: string, headers: string[], data: RemixNode[][]) {
  return (
    <section class="admin-section">
      <h2>{title}</h2>
      {data.length ? (
        <div class="table-scroll">
          <table
            class={'data-table' + (headers.length > 3 ? ' mobile-records' : '')}
            role="table"
            aria-label={title}
          >
            <thead>
              <tr>
                {headers.map((h) => (
                  <th scope="col">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr>
                  {row.map((value, index) => (
                    <td>
                      {headers.length > 3 ? (
                        <span class="mobile-cell-label" aria-hidden="true">
                          {headers[index]}
                        </span>
                      ) : null}
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="quiet">No records.</p>
      )}
    </section>
  )
}
function quickAction(
  csrf: string,
  endpoint: string,
  action: string,
  values: Record<string, string>,
  label: string,
  danger = false,
) {
  return (
    <form
      method="post"
      action={endpoint === admin ? '/_/admin' : '/_/account'}
      data-json-form
      data-endpoint={endpoint}
      data-confirm={danger ? label : undefined}
      class="compact-form"
    >
      {csrfField(csrf)}
      <input type="hidden" name="action" value={action} />
      {Object.entries(values).map(([key, value]) => (
        <input type="hidden" name={key} value={value} />
      ))}
      <button type="submit" class={danger ? 'danger-text' : 'secondary'}>
        {label}
      </button>
      <span data-form-error role="alert" hidden></span>
    </form>
  )
}
const admin = '/_/api/v1/admin',
  self = '/_/api/v1/account'
const actions = [
  'list',
  'read',
  'create',
  'upload',
  'modify',
  'rename',
  'copy',
  'move',
  'delete',
  'share',
  'manage',
]
export async function renderAdmin(
  page: Shell & {
    data: unknown
    retentionDays: number
    contentLimits: ContentLimits
    runtime: {
      version: string
      platform: string
      architecture: string
      limits: NonNullable<AppConfig['transferLimits']>
    }
  },
) {
  const form = settingsForm.bind(null, page.csrf),
    quick = quickAction.bind(null, page.csrf)
  const users = rows(page.data, 'users'),
    groups = rows(page.data, 'groups'),
    grants = rows(page.data, 'grants'),
    memberships = rows(page.data, 'memberships'),
    sessions = rows(page.data, 'sessions'),
    tokens = rows(page.data, 'tokens'),
    homes = rows(page.data, 'homes'),
    audit = rows(page.data, 'audit'),
    activity = rows(page.data, 'activity'),
    transfers = rows(page.data, 'transfers')
  const userOptions = users.map((u) => ({
      value: str(u.id),
      label: str(u.username),
    })),
    groupOptions = groups.map((g) => ({ value: str(g.id), label: str(g.name) }))
  const mountOptions = page.mounts.map((m) => ({ value: m.id, label: m.label }))
  const enabledAdmins = users.filter((u) => u.admin && u.enabled).length
  const storage = rows(page.data, 'mounts')
  const usage = new Map(
    rows(page.data, 'quotaUsage').map((row) => [row.actor, row]),
  )
  const caps = page.runtime.limits
  const transferRate = transfers.reduce(
    (total, t) => total + Number(t.bytesPerSecond || 0),
    0,
  )
  const area = (
    <div class="admin-layout">
      <nav class="subnav" aria-label="Administration sections">
        <a href="#accounts">Accounts</a>
        <a href="#access">Permissions</a>
        <a href="#roots">Storage</a>
        <a href="#activity">Activity</a>
        <a href="#settings">Settings</a>
      </nav>
      <section id="accounts">
        {table(
          'Users',
          [
            'Username',
            'Role',
            'State',
            'Upload quota',
            'Transfer bandwidth',
            'Actions',
          ],
          users.map((u) => [
            str(u.username),
            u.admin ? 'Administrator' : 'Member',
            u.enabled ? 'Enabled' : 'Disabled',
            quotaLabel(
              Number(usage.get(u.id)?.used ?? 0),
              Number(usage.get(u.id)?.reserved ?? 0),
              u.quota == null ? null : Number(u.quota),
            ),
            u.bandwidth == null
              ? 'Unlimited'
              : sizeLabel(Number(u.bandwidth)) + '/s',
            u.admin && u.enabled && enabledAdmins === 1 ? (
              <span class="quiet">Last administrator</span>
            ) : (
              quick(
                admin,
                'setEnabled',
                { userId: str(u.id), enabled: String(!u.enabled) },
                u.enabled ? 'Disable' : 'Enable',
                !!u.enabled,
              )
            ),
          ]),
        )}
        {form(
          admin,
          'createUser',
          'Create user',
          <>
            {input('Username', 'username')}
            {input('Password', 'password', 'password')}
            <label class="check-note">
              <input type="checkbox" name="admin" value="true" />
              Administrator
            </label>
          </>,
          'Create user',
        )}
        {users.length ? (
          <>
            {form(
              admin,
              'resetPassword',
              'Reset a password',
              <>
                {options('User', 'userId', userOptions)}
                {input('New password', 'password', 'password')}
              </>,
              'Reset password',
            )}
            {form(
              admin,
              'setAdmin',
              'Change account role',
              <>
                {options('User', 'userId', userOptions)}
                {options('Role', 'admin', [
                  { value: 'false', label: 'Member' },
                  { value: 'true', label: 'Administrator' },
                ])}
              </>,
              'Save role',
            )}
            {mountOptions.length
              ? form(
                  admin,
                  'setHome',
                  'Assign a private home',
                  <>
                    {options('User', 'userId', userOptions)}
                    {options('Storage', 'mountId', mountOptions)}
                    {input('Existing folder path', 'path')}
                  </>,
                  'Assign home',
                )
              : null}
            {form(
              admin,
              'setQuota',
              'Set upload quota',
              <>
                {options('User', 'userId', userOptions)}
                {input(
                  'Maximum bytes (blank for unlimited)',
                  'bytes',
                  'number',
                  false,
                )}
              </>,
              'Save quota',
            )}
            {form(
              admin,
              'setBandwidth',
              'Set transfer bandwidth',
              <>
                {options('User', 'userId', userOptions)}
                {input(
                  'Bytes per second (blank for unlimited)',
                  'bytesPerSecond',
                  'number',
                  false,
                )}
                <p class="quiet">
                  The account shares this rate across uploads and downloads.
                </p>
              </>,
              'Save bandwidth',
            )}
          </>
        ) : null}
        <details class="setting-form">
          <summary>Account sessions and tokens{icon('down', 15)}</summary>
          {table(
            'Signed-in sessions',
            ['User', 'Device', 'Last active (UTC)', 'Action'],
            sessions.map((s) => [
              userOptions.find((u) => u.value === s.userId)?.label ||
                str(s.userId),
              device(s),
              dateLabel(Number(s.lastSeen)),
              quick(
                admin,
                'revokeSession',
                { id: str(s.id) },
                'Sign out session',
                true,
              ),
            ]),
          )}
          {table(
            'Issued tokens',
            ['User', 'Label', 'Scope', 'Expires', 'Action'],
            tokens.map((t) => [
              userOptions.find((u) => u.value === t.userId)?.label ||
                str(t.userId),
              str(t.label),
              Array.isArray(t.scope) ? t.scope.join(', ') : str(t.scope),
              dateLabel(Number(t.expiresAt)),
              quick(
                admin,
                'revokeToken',
                { id: str(t.id) },
                'Revoke token',
                true,
              ),
            ]),
          )}
        </details>
      </section>
      <section id="access">
        {homes.length
          ? table(
              'Private homes',
              ['User', 'Storage', 'Folder'],
              homes.map((h) => [
                userOptions.find((u) => u.value === h.userId)?.label ||
                  str(h.userId),
                mountOptions.find((m) => m.value === h.mountId)?.label ||
                  str(h.mountId),
                str(h.path),
              ]),
            )
          : null}
        {table(
          'Groups',
          ['Group', 'Members'],
          groups.map((g) => [
            str(g.name),
            memberships
              .filter((m) => m.groupId === g.id)
              .map((m) => userOptions.find((u) => u.value === m.userId)?.label)
              .filter(Boolean)
              .join(', ') || 'No members',
          ]),
        )}
        {form(
          admin,
          'createGroup',
          'Create group',
          input('Group name', 'name'),
          'Create group',
        )}
        {groupOptions.length && userOptions.length
          ? form(
              admin,
              'setMembership',
              'Edit group membership',
              <>
                {options('Group', 'groupId', groupOptions)}
                {options('User', 'userId', userOptions)}
                {options('Membership', 'member', [
                  { value: 'true', label: 'Add to group' },
                  { value: 'false', label: 'Remove from group' },
                ])}
              </>,
              'Save membership',
            )
          : null}
        {table(
          'Directory grants',
          ['Principal', 'Storage', 'Path', 'Permission', 'Effect'],
          grants.map((g) => [
            str(g.subjectType) === 'user'
              ? userOptions.find((u) => u.value === g.subjectId)?.label ||
                str(g.subjectId)
              : groupOptions.find((v) => v.value === g.subjectId)?.label ||
                str(g.subjectId),
            mountOptions.find((m) => m.value === g.mountId)?.label ||
              str(g.mountId),
            str(g.path) || '/',
            str(g.permission),
            str(g.effect),
          ]),
        )}
        {mountOptions.length
          ? form(
              admin,
              'setGrant',
              'Change a directory grant',
              <>
                <label>
                  Principal
                  <select name="principal" required>
                    {userOptions.map((u) => (
                      <option value={'user:' + u.value}>
                        {u.label} (user)
                      </option>
                    ))}
                    {groupOptions.map((g) => (
                      <option value={'group:' + g.value}>
                        {g.label} (group)
                      </option>
                    ))}
                  </select>
                </label>
                {options('Storage', 'mountId', mountOptions)}
                {input(
                  'Directory path (blank for root)',
                  'path',
                  'text',
                  false,
                )}
                {options(
                  'Permission',
                  'permission',
                  actions.map((a) => ({ value: a, label: a })),
                )}
                {options(
                  'Effect',
                  'effect',
                  ['allow', 'deny', 'remove'].map((v) => ({
                    value: v,
                    label: v,
                  })),
                )}
              </>,
              'Save grant',
            )
          : null}
      </section>
      <section id="roots">
        {table(
          'Storage roots',
          ['Label', 'Mode', 'Availability', 'Free space', 'Trash retention'],
          page.mounts.map((m) => {
            const info = storage.find((s) => s.id === m.id)
            return [
              m.label,
              m.readOnly ? 'Read only' : 'Writable',
              m.available === false || info?.available === false
                ? 'Unavailable'
                : 'Available',
              typeof info?.free === 'number' ? sizeLabel(info.free) : '—',
              typeof info?.retentionMs === 'number'
                ? String(info.retentionMs / 86400000) + ' days'
                : String(page.retentionDays) + ' days (workspace default)',
            ]
          }),
        )}
        {mountOptions.length
          ? form(
              admin,
              'setMount',
              'Configure storage',
              <>
                {options('Storage', 'mountId', mountOptions)}
                {input('Display name', 'label', 'text', false)}
                {options('State', 'enabled', [
                  { value: 'keep', label: 'Keep current state' },
                  { value: 'true', label: 'Enabled' },
                  { value: 'false', label: 'Disabled' },
                ])}
              </>,
              'Save storage',
            )
          : null}
        {mountOptions.length
          ? form(
              admin,
              'setMount',
              'Set storage trash retention',
              <>
                {options('Storage', 'mountId', mountOptions)}
                {input(
                  'Retention in days (blank for workspace default)',
                  'retentionDays',
                  'number',
                  false,
                )}
              </>,
              'Save retention',
            )
          : null}
      </section>
      <section id="activity">
        <section class="admin-section" id="admin-transfers">
          <h2>Live transfers</h2>
          <p>
            Aggregate bandwidth{' '}
            <strong data-transfer-rate>{sizeLabel(transferRate)}/s</strong>
          </p>
          <p data-transfer-empty class="quiet" hidden={transfers.length > 0}>
            No active transfers.
          </p>
          <div
            class="table-scroll"
            data-transfer-table
            hidden={!transfers.length}
          >
            <table class="data-table">
              <thead>
                <tr>
                  {['Transfer', 'Progress', 'Speed', 'Action'].map((h) => (
                    <th scope="col">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr data-transfer-id={str(t.id)}>
                    <td>{str(t.kind)}</td>
                    <td>
                      {sizeLabel(Number(t.bytes))}
                      {t.total == null
                        ? ''
                        : ' / ' + sizeLabel(Number(t.total))}
                    </td>
                    <td>{sizeLabel(Number(t.bytesPerSecond))}/s</td>
                    <td>
                      <button type="button" data-cancel-transfer={str(t.id)}>
                        Cancel transfer
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <a
          class="button"
          href="/_/api/v1/admin/diagnostics"
          download
          data-rmx-document
        >
          {icon('download', 16)}Download diagnostics
        </a>
        {table(
          'Recent requests',
          ['Time (UTC)', 'Operation', 'Status', 'Duration', 'Request ID'],
          activity.map((a) => [
            new Date(Number(a.recorded_at))
              .toISOString()
              .replace('T', ' ')
              .slice(0, 19),
            str(a.operation),
            str(a.status),
            str(a.duration_ms) + ' ms',
            str(a.request_id),
          ]),
        )}
        {table(
          'Activity log',
          ['Time (UTC)', 'Event', 'Actor'],
          audit.map((a) => [
            dateLabel(Number(a.at)),
            str(a.event),
            str(a.actor) || 'System',
          ]),
        )}
      </section>
      <section id="settings" class="admin-section">
        <h2>Settings</h2>
        <section aria-label="Server configuration">
          <h3>Server configuration</h3>
          <dl class="profile">
            <dt>Runtime</dt>
            <dd>
              Bun {page.runtime.version} · {page.runtime.platform}{' '}
              {page.runtime.architecture}
            </dd>
            <dt>Concurrent transfers</dt>
            <dd>
              {caps.maxConcurrent} total, {caps.perActorConcurrent} per actor
            </dd>
            <dt>Maximum upload chunk</dt>
            <dd>{sizeLabel(caps.maxChunkBytes)}</dd>
            <dt>Per-transfer bandwidth</dt>
            <dd>
              {caps.bytesPerSecond
                ? sizeLabel(caps.bytesPerSecond) + '/s'
                : 'Unlimited'}
            </dd>
            <dt>Resumable upload expiry</dt>
            <dd>{caps.uploadTtlMs / 1000} seconds</dd>
          </dl>
        </section>
        {form(
          admin,
          'setContentLimits',
          'Preview and staging limits',
          <>
            <p>
              Formatted previews also follow the text preview limit. Set either
              staging limit to zero for unlimited capacity. Changes to staging
              limits apply to new uploads.
            </p>
            {contentLimitFields.map(({ key, label, min, max }) => (
              <label>
                {label}
                <input
                  name={key}
                  type="number"
                  min={min}
                  max={max}
                  step={1}
                  required
                  value={page.contentLimits[key]}
                />
              </label>
            ))}
          </>,
          'Save limits',
        )}
        {form(
          admin,
          'setSettings',
          'Brand and retention',
          <>
            <label>
              Workspace name
              <input
                name="brand"
                type="text"
                maxLength={60}
                value={page.brand}
              />
            </label>
            <label>
              Trash retention (days)
              <input
                name="trashRetentionDays"
                type="number"
                min="1"
                max="3650"
                value={page.retentionDays}
              />
            </label>
          </>,
          'Save settings',
        )}
      </section>
      {confirmDialog()}
    </div>
  )
  return documentPage(
    'Administration',
    appShell(page, 'admin', 'Administration', area),
    page.csrf,
    200,
    page.brand,
    page.theme,
  )
}
export async function renderAccount(
  page: Shell & {
    data: unknown
    issuedToken?: string
    used: number
    reserved: number
    quota: number | null
    bandwidth: number
  },
) {
  const form = settingsForm.bind(null, page.csrf),
    quick = quickAction.bind(null, page.csrf)
  const sessions = rows(page.data, 'sessions'),
    tokens = rows(page.data, 'tokens')
  const body = (
    <div class="admin-layout">
      <section class="admin-section" aria-labelledby="profile-heading">
        <h2 id="profile-heading">Profile</h2>
        <dl class="profile">
          <dt>Username</dt>
          <dd>{page.user.username}</dd>
          <dt>Role</dt>
          <dd>{page.user.admin ? 'Administrator' : 'Member'}</dd>
          <dt>Upload quota</dt>
          <dd>{quotaLabel(page.used, page.reserved, page.quota)}</dd>
          <dt>Transfer bandwidth</dt>
          <dd>
            {page.bandwidth ? sizeLabel(page.bandwidth) + '/s' : 'Unlimited'}
          </dd>
        </dl>
        <details class="setting-form">
          <summary>Folder permission IDs {icon('down', 15)}</summary>
          <p>
            Give your account or group ID to a folder manager to receive access.
          </p>
          <dl class="profile">
            <dt>Account ID</dt>
            <dd>
              <code>{page.user.id}</code>
            </dd>
            {rows(page.data, 'groups').map((group) => (
              <>
                <dt>{str(group.name)} group ID</dt>
                <dd>
                  <code>{str(group.id)}</code>
                </dd>
              </>
            ))}
          </dl>
        </details>
        {form(
          self,
          'changePassword',
          'Change password',
          <>
            <label>
              Current password
              <input
                name="currentPassword"
                type="password"
                required
                autocomplete="current-password"
              />
            </label>
            {input('New password', 'password', 'password')}
          </>,
          'Update password',
        )}
      </section>
      {table(
        'Sessions',
        ['Device', 'Last active', 'Started', 'Action'],
        sessions.map((s) => [
          device(s),
          dateLabel(Number(s.lastSeen)),
          dateLabel(Number(s.createdAt)),
          quick(
            self,
            'revokeSession',
            { id: str(s.id) },
            'Sign out session',
            true,
          ),
        ]),
      )}
      {table(
        'API tokens',
        ['Label', 'Scope', 'Expires', 'Action'],
        tokens.map((t) => [
          str(t.label),
          Array.isArray(t.scope) ? t.scope.join(', ') : str(t.scope),
          dateLabel(Number(t.expiresAt)),
          quick(self, 'revokeToken', { id: str(t.id) }, 'Revoke', true),
        ]),
      )}
      {form(
        self,
        'issueToken',
        'Create API token',
        <>
          {input('Label', 'label')}
          <label>
            Permissions
            <select name="scope">
              <option value="list,read">List and read</option>
              <option value="list">List only</option>
              <option value="read">Read only</option>
            </select>
          </label>
          {input('Expires in days', 'days', 'number')}
        </>,
        'Create token',
      )}
      <form method="post" action="/logout" class="sign-out">
        {csrfField(page.csrf)}
        <button type="submit">{icon('exit', 16)}Sign out</button>
      </form>
      {confirmDialog()}
      {page.issuedToken ? (
        <dialog open aria-labelledby="issued-token-heading">
          <h2 id="issued-token-heading">New API token</h2>
          <p>Copy this token now. It is shown once.</p>
          <details>
            <summary>Show token</summary>
            <label>
              API token
              <input
                type="text"
                readOnly
                autocomplete="off"
                value={page.issuedToken}
                data-new-token
              />
            </label>
          </details>
          <button type="button" data-copy-token>
            Copy token
          </button>
          <form method="get" action="/_/account">
            <button type="submit">Done</button>
          </form>
        </dialog>
      ) : null}
      {dialog(
        'token-result',
        'New API token',
        <>
          <p>Copy this token now. It is shown once.</p>
          <label>
            API token
            <input type="password" readOnly autocomplete="off" data-new-token />
          </label>
          <div class="dialog-actions">
            <button type="button" data-show-token aria-pressed="false">
              Show token
            </button>
            <button type="button" data-copy-token>
              Copy token
            </button>
            <button type="button" data-close>
              Done
            </button>
          </div>
        </>,
      )}
    </div>
  )
  return documentPage(
    'Account',
    appShell(page, 'account', 'Account', body),
    page.csrf,
    200,
    page.brand,
    page.theme,
  )
}
