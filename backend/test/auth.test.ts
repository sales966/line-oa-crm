/**
 * auth.test.ts — 帐号与 session 关键不变量(临时库 + bcryptjs + 逐字复制的 authService SQL)。
 * 覆盖:
 *  - 密码 bcrypt 验证:正确密码过、错误密码拒。
 *  - 停用用户即使密码对也拒登(active !== 1 → null)。
 *  - session 过期后查不到使用者(expiresAt < now)。
 *  - 停用用户已发出的 session 立即失效(getSessionUser 的 u.active = 1 条件)。
 *  - 惰性清理:purge 删除过期 session 行。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  createTestDb,
  closeTestDb,
  type TestDb,
  SQL_GET_SESSION_USER,
  SQL_PURGE_EXPIRED_SESSIONS,
} from './helpers.js';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
let T: TestDb;
let db: Database.Database;
let userId: number;

beforeEach(() => {
  T = createTestDb();
  db = T.db;
  const hash = bcrypt.hashSync('correct-horse', 10);
  userId = Number(
    db
      .prepare(
        'INSERT INTO users (username, displayName, role, passwordHash, active, createdAt) VALUES (?, ?, ?, ?, 1, ?)'
      )
      .run('alice', 'Alice', '跟單', hash, Date.now()).lastInsertRowid
  );
});
afterEach(() => closeTestDb(T));

// authService.verifyLogin 的等价逻辑
function verifyLogin(username: string, password: string): { id: number } | null {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) as
    | { id: number; passwordHash: string; active: number }
    | undefined;
  if (!row || row.active !== 1) return null;
  if (!bcrypt.compareSync(password, row.passwordHash)) return null;
  return { id: row.id };
}
// authService.createSession 的等价逻辑(含惰性清理)
function createSession(uid: number, expiresAt: number): string {
  db.prepare(SQL_PURGE_EXPIRED_SESSIONS).run(Date.now());
  const token = crypto.randomUUID() + crypto.randomUUID();
  db.prepare('INSERT INTO sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)').run(
    token,
    uid,
    Date.now(),
    expiresAt
  );
  return token;
}
function getSessionUser(token: string) {
  return db.prepare(SQL_GET_SESSION_USER).get(token, Date.now()) as { id: number } | undefined;
}

test('bcrypt:正确密码通过,错误密码拒绝', () => {
  assert.equal(verifyLogin('alice', 'correct-horse')?.id, userId);
  assert.equal(verifyLogin('alice', 'wrong'), null);
  assert.equal(verifyLogin('nobody', 'correct-horse'), null, '不存在的帐号');
});

test('停用用户即使密码正确也拒登', () => {
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(userId);
  assert.equal(verifyLogin('alice', 'correct-horse'), null);
});

test('有效 session 可查到使用者', () => {
  const token = createSession(userId, Date.now() + TTL_MS);
  assert.equal(getSessionUser(token)?.id, userId);
});

test('过期 session 查不到使用者', () => {
  const token = createSession(userId, Date.now() - 1000); // 已过期
  assert.equal(getSessionUser(token), undefined);
});

test('停用用户的既有 session 立即失效', () => {
  const token = createSession(userId, Date.now() + TTL_MS);
  assert.ok(getSessionUser(token), '停用前有效');
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(userId);
  assert.equal(getSessionUser(token), undefined, '停用后 session 失效');
});

test('惰性清理:建 session 时删除过期行', () => {
  db.prepare('INSERT INTO sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)').run(
    'stale-token',
    userId,
    Date.now() - TTL_MS,
    Date.now() - 1000
  );
  createSession(userId, Date.now() + TTL_MS); // 内部 purge
  const stale = db.prepare('SELECT token FROM sessions WHERE token = ?').get('stale-token');
  assert.equal(stale, undefined, '过期 session 应被惰性清理');
});
