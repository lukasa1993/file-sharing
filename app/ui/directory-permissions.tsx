/** @jsxImportSource remix/component */
import type { ResourceRef } from '../contracts.ts'
import type { directoryPermissions } from '../identity/directory-permissions.ts'
import {
  appShell,
  csrfField,
  documentPage,
  refUrl,
  type Shell,
} from './base.tsx'

export function renderDirectoryPermissions(
  shell: Shell,
  ref: ResourceRef,
  permissions: ReturnType<typeof directoryPermissions>,
) {
  const href = refUrl('/_/folder-permissions', ref)
  const label =
    ref.segments.at(-1) ??
    shell.mounts.find((m) => m.id === ref.mountId)?.label ??
    'Storage'
  const page = (
    <div class="admin-layout">
      <section class="admin-section">
        <h2>{label}</h2>
        <p>
          <a href={refUrl('/_/files', ref)}>Back to folder</a>
        </p>
        {permissions.available.length ? (
          <form
            method="post"
            action={href}
            aria-label="Grant folder access"
            data-rmx-document
          >
            {csrfField(shell.csrf)}
            <input type="hidden" name="operation" value="grant" />
            <label>
              Recipient type
              <select name="subjectType">
                <option value="user">Account</option>
                <option value="group">Group</option>
              </select>
            </label>
            <label>
              Recipient ID
              <input
                name="subjectId"
                required
                maxLength={36}
                autocomplete="off"
                aria-describedby="recipient-hint"
              />
            </label>
            <p id="recipient-hint">
              Ask the recipient for the ID shown under Folder permission IDs on
              their Account page.
            </p>
            <label>
              Permission
              <select name="permission">
                {permissions.available.map((action) => (
                  <option value={action}>{action}</option>
                ))}
              </select>
            </label>
            <button type="submit">Grant permission</button>
          </form>
        ) : (
          <p>You have no permissions to grant on this folder.</p>
        )}
      </section>
      <section class="admin-section">
        <h2>Permissions you granted here</h2>
        <p>
          Each grant applies within this folder while you retain the permission
          and manage access. Administrator rules still apply.
        </p>
        {permissions.grants.length ? (
          <div class="table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Recipient</th>
                  <th>Permission</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {permissions.grants.map((grant) => (
                  <tr>
                    <td>
                      {grant.name} (
                      {grant.subjectType === 'user' ? 'account' : 'group'})
                    </td>
                    <td>{grant.permission}</td>
                    <td>
                      <form method="post" action={href} data-rmx-document>
                        {csrfField(shell.csrf)}
                        <input
                          type="hidden"
                          name="operation"
                          value="withdraw"
                        />
                        <input
                          type="hidden"
                          name="subjectType"
                          value={grant.subjectType}
                        />
                        <input
                          type="hidden"
                          name="subjectId"
                          value={grant.subjectId}
                        />
                        <input
                          type="hidden"
                          name="permission"
                          value={grant.permission}
                        />
                        <button
                          type="submit"
                          aria-label={
                            'Withdraw ' +
                            grant.permission +
                            ' for ' +
                            grant.name
                          }
                        >
                          Withdraw
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>You have granted no permissions here.</p>
        )}
      </section>
    </div>
  )
  return documentPage(
    'Folder permissions',
    appShell(shell, 'files', 'Folder permissions', page),
    shell.csrf,
    200,
    shell.brand,
    shell.theme,
  )
}
