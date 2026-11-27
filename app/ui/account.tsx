/** @jsxImportSource remix/component */
import type { RemixNode } from 'remix/component'
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
        action={endpoint}
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
function table(title: string, headers: string[], data: RemixNode[][]) {
  return (
    <section class="admin-section">
      <h2>{title}</h2>
      {data.length ? (
        <div class="table-scroll">
          <table class="data-table">
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
                  {row.map((value) => (
                    <td>{value}</td>
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
      action={endpoint}
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
export async function renderAdmin(page: Shell & { data: unknown }) {
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
  const storage = rows(page.data, 'mounts')
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
          ['Username', 'Role', 'State', 'Upload quota', 'Actions'],
          users.map((u) => [
            str(u.username),
            u.admin ? 'Administrator' : 'Member',
            u.enabled ? 'Enabled' : 'Disabled',
            u.quota == null ? 'Unlimited' : sizeLabel(Number(u.quota)),
            quick(
              admin,
              'setEnabled',
              { userId: str(u.id), enabled: String(!u.enabled) },
              u.enabled ? 'Disable' : 'Enable',
              !!u.enabled,
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
          </>
        ) : null}
        <details class="setting-form">
          <summary>Account sessions and tokens{icon('down', 15)}</summary>
          {table(
            'Signed-in sessions',
            ['User', 'Last active (UTC)', 'Action'],
            sessions.map((s) => [
              userOptions.find((u) => u.value === s.userId)?.label ||
                str(s.userId),
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
          ['Label', 'Mode', 'Availability', 'Free space'],
          page.mounts.map((m) => {
            const info = storage.find((s) => s.id === m.id)
            return [
              m.label,
              m.readOnly ? 'Read only' : 'Writable',
              m.available === false || info?.available === false
                ? 'Unavailable'
                : 'Available',
              typeof info?.free === 'number' ? sizeLabel(info.free) : '—',
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
        {form(
          admin,
          'setSettings',
          'Brand and retention',
          <>
            {input('Workspace name', 'brand', 'text', false)}
            {input(
              'Trash retention (days)',
              'trashRetentionDays',
              'number',
              false,
            )}
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
  )
}
export async function renderAccount(page: Shell & { data: unknown }) {
  const form = settingsForm.bind(null, page.csrf),
    quick = quickAction.bind(null, page.csrf)
  const sessions = rows(page.data, 'sessions'),
    tokens = rows(page.data, 'tokens')
  const body = (
    <div class="admin-layout">
      <section class="admin-section">
        <h2>Profile</h2>
        <dl class="profile">
          <dt>Username</dt>
          <dd>{page.user.username}</dd>
          <dt>Role</dt>
          <dd>{page.user.admin ? 'Administrator' : 'Member'}</dd>
        </dl>
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
        ['Last active', 'Started', 'Action'],
        sessions.map((s) => [
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
      {dialog(
        'token-result',
        'New API token',
        <>
          <p>Copy this token now. It is shown once.</p>
          <textarea readOnly data-new-token></textarea>
          <div class="dialog-actions">
            <button data-close>Done</button>
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
  )
}
