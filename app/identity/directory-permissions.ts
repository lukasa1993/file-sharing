import { Effect } from 'effect'
import {
  actions,
  AppError,
  type Action,
  type ResourceRef,
  type User,
} from '../contracts.ts'
import { asAppError } from '../effects.ts'
import type { Identity } from './index.ts'

type SubjectType = 'user' | 'group'
type Grant = {
  subjectType: SubjectType
  subjectId: string
  name: string
  permission: Action
}
const denied = () =>
  new AppError(403, 'You do not manage these folder permissions.')

export function permittedByDirectoryGrant(
  identity: Identity,
  user: User,
  action: Action,
  ref: ResourceRef,
) {
  const path = ref.segments.join('/')
  const grants = identity.db
    .query<
      { issuer: string; path: string },
      [string, string, string, string, string, string, string]
    >(
      `SELECT issuer,path FROM auth_directory_grants
     WHERE mountId=? AND permission=? AND issuer<>?
     AND (path='' OR path=? OR substr(?,1,length(path)+1)=path||'/')
     AND ((subjectType='user' AND subjectId=?) OR (subjectType='group' AND subjectId IN
          (SELECT groupId FROM auth_members WHERE userId=?)))`,
    )
    .iterate(ref.mountId, action, user.id, path, path, user.id, user.id)
  for (const grant of grants) {
    const issuer = identity.getUser(grant.issuer)
    if (!issuer || !identity.canDelegate(issuer, action, ref)) continue
    if (
      path === grant.path ||
      identity.canDelegate(issuer, action, {
        mountId: ref.mountId,
        segments: grant.path ? grant.path.split('/') : [],
      })
    )
      return true
  }
  return false
}

function requireManage(identity: Identity, user: User, ref: ResourceRef) {
  if (!identity.allowed(user, 'manage', ref)) throw denied()
}

export function directoryPermissions(
  identity: Identity,
  user: User,
  ref: ResourceRef,
) {
  requireManage(identity, user, ref)
  const grants = identity.db
    .query<Grant, [string, string, string]>(
      `SELECT d.subjectType,d.subjectId,d.permission,coalesce(u.username,g.name) AS name
     FROM auth_directory_grants d
     LEFT JOIN auth_users u ON d.subjectType='user' AND d.subjectId=u.id
     LEFT JOIN auth_groups g ON d.subjectType='group' AND d.subjectId=g.id
     WHERE issuer=? AND mountId=? AND path=? AND (u.id IS NOT NULL OR g.id IS NOT NULL)
     ORDER BY name,d.permission`,
    )
    .all(user.id, ref.mountId, ref.segments.join('/'))
  return {
    grants,
    available: actions.filter((a) => identity.canDelegate(user, a, ref)),
  }
}

export function changeDirectoryPermission(
  identity: Identity,
  user: User,
  ref: ResourceRef,
  fields: Record<string, unknown>,
) {
  const change = identity.db.transaction(() => {
    requireManage(identity, user, ref)
    const { operation, subjectType, subjectId, permission } = fields
    if (
      (operation !== 'grant' && operation !== 'withdraw') ||
      (subjectType !== 'user' && subjectType !== 'group') ||
      typeof subjectId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(subjectId) ||
      !actions.some((a) => a === permission) ||
      permission === 'manage'
    )
      throw new AppError(400, 'Choose a recipient ID and a folder permission.')
    const action = permission as Action
    const path = ref.segments.join('/')
    if (operation === 'withdraw') {
      identity.db
        .query(
          `DELETE FROM auth_directory_grants
        WHERE issuer=? AND mountId=? AND path=? AND subjectType=? AND subjectId=? AND permission=?`,
        )
        .run(user.id, ref.mountId, path, subjectType, subjectId, action)
    } else {
      if (!identity.canDelegate(user, action, ref)) throw denied()
      const recipient =
        subjectType === 'user'
          ? identity.db
              .query(
                'SELECT 1 FROM auth_users WHERE id=? AND id<>? AND enabled=1',
              )
              .get(subjectId, user.id)
          : identity.db
              .query(
                `SELECT 1 FROM auth_groups WHERE id=? AND NOT EXISTS
          (SELECT 1 FROM auth_members WHERE groupId=auth_groups.id AND userId=?)`,
              )
              .get(subjectId, user.id)
      if (!recipient)
        throw new AppError(400, 'Choose another valid recipient ID.')
      identity.db
        .query(
          `INSERT OR IGNORE INTO auth_directory_grants
        (issuer,mountId,path,subjectType,subjectId,permission) VALUES(?,?,?,?,?,?)`,
        )
        .run(user.id, ref.mountId, path, subjectType, subjectId, action)
    }
    identity.audit(user.id, 'directory.' + operation)
  })
  return Effect.runSync(
    Effect.try({ try: () => change.immediate(), catch: asAppError }),
  )
}
