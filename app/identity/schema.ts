import type { Database } from 'bun:sqlite'

export function initializeIdentitySchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY,
      username TEXT COLLATE NOCASE NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      admin INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      quota INTEGER CHECK(quota IS NULL OR quota >= 0)
    );
    CREATE TABLE IF NOT EXISTS auth_groups (
      id TEXT PRIMARY KEY, name TEXT COLLATE NOCASE NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS auth_members (
      userId TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      groupId TEXT NOT NULL REFERENCES auth_groups(id) ON DELETE CASCADE,
      PRIMARY KEY (userId, groupId)
    );
    CREATE TABLE IF NOT EXISTS auth_homes (
      userId TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
      mountId TEXT NOT NULL, path TEXT NOT NULL CHECK(path <> ''),
      UNIQUE(mountId,path)
    );
    CREATE TABLE IF NOT EXISTS auth_grants (
      subjectType TEXT NOT NULL CHECK(subjectType IN ('user','group')),
      subjectId TEXT NOT NULL, mountId TEXT NOT NULL, path TEXT NOT NULL,
      permission TEXT NOT NULL, effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
      PRIMARY KEY (subjectType, subjectId, mountId, path, permission)
    );
    CREATE INDEX IF NOT EXISTS auth_grant_lookup ON auth_grants(mountId,permission,subjectType,subjectId);
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY, publicId TEXT NOT NULL UNIQUE,
      userId TEXT REFERENCES auth_users(id) ON DELETE CASCADE,
      data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, lastSeen INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_session_user ON auth_sessions(userId);
    CREATE INDEX IF NOT EXISTS auth_session_seen ON auth_sessions(lastSeen);
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE,
      userId TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      label TEXT NOT NULL, scope TEXT NOT NULL, expiresAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_token_user ON auth_tokens(userId);
    CREATE TABLE IF NOT EXISTS auth_audit (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT, event TEXT NOT NULL
    );
  `)
}
