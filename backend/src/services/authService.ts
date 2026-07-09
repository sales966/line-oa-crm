/**
 * authService.ts — 帐号与 session 业务逻辑(routes 不直接碰 db)。
 * - 密码 bcryptjs(纯 JS,免原生编译)散列
 * - session token = 两段 crypto.randomUUID 拼接,有效期 7 天
 * - 登入失败节流:同 IP 连续失败 5 次锁 60 秒(内存 Map,重启即清)
 * - 过期 session 惰性清理:login 建 session 时顺手 DELETE expiresAt < now
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { TEAM_ROLES, type TeamRole } from './teamChatService.js';

export const SESSION_COOKIE = 'lineoa_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS = 10;

/** 挂到 req.user / 回给前端的公开字段(绝不含 passwordHash) */
export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: TeamRole;
}

/** 使用者管理列表用(仍不含 passwordHash) */
export interface UserListRow extends SessionUser {
  active: number;
  createdAt: number | null;
}

interface DbUserRow extends UserListRow {
  passwordHash: string;
}

const toSessionUser = (r: DbUserRow): SessionUser => ({
  id: r.id,
  username: r.username,
  displayName: r.displayName,
  role: r.role,
});

// ---------- 登入节流(同 IP 连续失败 5 次锁 60 秒) ----------

const LOCK_AFTER_FAILS = 5;
const LOCK_MS = 60_000;
/** 条目闲置超过此时长即回收,防 Map 无限增长 */
const THROTTLE_IDLE_MS = 10 * 60_000;

interface ThrottleEntry {
  fails: number;
  lockedUntil: number;
  lastFailAt: number;
}
const loginThrottle = new Map<string, ThrottleEntry>();

export function isLoginLocked(ip: string): boolean {
  const e = loginThrottle.get(ip);
  if (!e) return false;
  const now = Date.now();
  if (e.lockedUntil > now) return true;
  if (now - e.lastFailAt > THROTTLE_IDLE_MS) loginThrottle.delete(ip); // 顺手回收
  return false;
}

export function noteLoginFailure(ip: string): void {
  const now = Date.now();
  const e = loginThrottle.get(ip) ?? { fails: 0, lockedUntil: 0, lastFailAt: 0 };
  if (e.lockedUntil && e.lockedUntil <= now) {
    e.fails = 0; // 锁已过期,重新计数
    e.lockedUntil = 0;
  }
  e.fails += 1;
  e.lastFailAt = now;
  if (e.fails >= LOCK_AFTER_FAILS) {
    e.lockedUntil = now + LOCK_MS;
    e.fails = 0;
  }
  loginThrottle.set(ip, e);
}

export function noteLoginSuccess(ip: string): void {
  loginThrottle.delete(ip);
}

// ---------- 登入 / session ----------

const getUserByUsernameStmt = db.prepare('SELECT * FROM users WHERE username = ?');
const getUserByIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');

/** 帐密验证;帐号不存在/密码错/已停用一律回 null(route 统一 401,不泄漏原因) */
export function verifyLogin(username: unknown, password: unknown): SessionUser | null {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  const row = getUserByUsernameStmt.get(username.trim()) as DbUserRow | undefined;
  if (!row || row.active !== 1) return null;
  if (!bcrypt.compareSync(password, row.passwordHash)) return null;
  return toSessionUser(row);
}

const insertSessionStmt = db.prepare(
  'INSERT INTO sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)'
);
const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE token = ?');
const purgeExpiredSessionsStmt = db.prepare('DELETE FROM sessions WHERE expiresAt < ?');
const getSessionUserStmt = db.prepare(`
  SELECT u.id, u.username, u.displayName, u.role
  FROM sessions s JOIN users u ON u.id = s.userId
  WHERE s.token = ? AND s.expiresAt >= ? AND u.active = 1
`);

export function createSession(userId: number): { token: string; expiresAt: number } {
  const now = Date.now();
  purgeExpiredSessionsStmt.run(now); // 惰性清理过期 session
  const token = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = now + SESSION_TTL_MS;
  insertSessionStmt.run(token, userId, now, expiresAt);
  return { token, expiresAt };
}

export function destroySession(token: string): void {
  deleteSessionStmt.run(token);
}

/** token → 使用者;无效/过期/已停用回 null */
export function getSessionUser(token: unknown): SessionUser | null {
  if (typeof token !== 'string' || !token) return null;
  return (getSessionUserStmt.get(token, Date.now()) as SessionUser | undefined) ?? null;
}

// ---------- 密码修改(本人) ----------

const updatePasswordStmt = db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?');

export type ChangePasswordResult = { ok: true } | { ok: false; error: string; unauthorized?: boolean };

export function changePassword(
  userId: number,
  oldPassword: unknown,
  newPassword: unknown
): ChangePasswordResult {
  const row = getUserByIdStmt.get(userId) as DbUserRow | undefined;
  if (!row || row.active !== 1) return { ok: false, error: '未登入', unauthorized: true };
  if (typeof oldPassword !== 'string' || !bcrypt.compareSync(oldPassword, row.passwordHash)) {
    return { ok: false, error: '舊密碼錯誤' };
  }
  const err = validatePassword(newPassword);
  if (err) return { ok: false, error: err };
  updatePasswordStmt.run(bcrypt.hashSync(newPassword as string, BCRYPT_ROUNDS), userId);
  return { ok: true };
}

function validatePassword(pw: unknown): string | null {
  if (typeof pw !== 'string' || pw.length < 6) return '密碼至少 6 個字元';
  return null;
}

// ---------- 使用者管理(仅 role=管理;权限由 route 检查) ----------

const listUsersStmt = db.prepare(
  'SELECT id, username, displayName, role, active, createdAt FROM users ORDER BY id ASC'
);

export function listUsers(): UserListRow[] {
  return listUsersStmt.all() as UserListRow[];
}

const insertUserStmt = db.prepare(`
  INSERT INTO users (username, displayName, role, passwordHash, active, createdAt)
  VALUES (?, ?, ?, ?, 1, ?)
`);

export type UserWriteResult =
  | { ok: true; user: UserListRow }
  | { ok: false; error: string; notFound?: boolean };

const isUniqueViolation = (e: unknown): boolean =>
  typeof (e as { code?: unknown })?.code === 'string' &&
  ((e as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    (e as { code: string }).code === 'SQLITE_CONSTRAINT');

export function createUser(input: {
  username?: unknown;
  displayName?: unknown;
  role?: unknown;
  password?: unknown;
}): UserWriteResult {
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  if (!username) return { ok: false, error: '缺少 username' };
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (!displayName) return { ok: false, error: '缺少 displayName' };
  const role = input.role;
  if (typeof role !== 'string' || !(TEAM_ROLES as readonly string[]).includes(role)) {
    return { ok: false, error: `role 必須是:${TEAM_ROLES.join(' / ')}` };
  }
  const pwErr = validatePassword(input.password);
  if (pwErr) return { ok: false, error: pwErr };

  const now = Date.now();
  try {
    const res = insertUserStmt.run(
      username,
      displayName,
      role,
      bcrypt.hashSync(input.password as string, BCRYPT_ROUNDS),
      now
    );
    return {
      ok: true,
      user: {
        id: Number(res.lastInsertRowid),
        username,
        displayName,
        role: role as TeamRole,
        active: 1,
        createdAt: now,
      },
    };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'username 已存在' };
    throw e;
  }
}

const updateUserStmt = db.prepare(`
  UPDATE users SET displayName = ?, role = ?, active = ?,
    passwordHash = COALESCE(?, passwordHash)
  WHERE id = ?
`);

/**
 * 改 displayName/role/active/重设密码(只改有带的字段)。
 * actingUserId 用于自我保护:不可停用/降级自己。
 */
export function updateUser(
  id: number,
  input: { displayName?: unknown; role?: unknown; active?: unknown; password?: unknown },
  actingUserId: number
): UserWriteResult {
  const row = getUserByIdStmt.get(id) as DbUserRow | undefined;
  if (!row) return { ok: false, error: '使用者不存在', notFound: true };

  let displayName = row.displayName;
  if (input.displayName !== undefined) {
    displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    if (!displayName) return { ok: false, error: 'displayName 不得為空' };
  }

  let role = row.role;
  if (input.role !== undefined) {
    if (
      typeof input.role !== 'string' ||
      !(TEAM_ROLES as readonly string[]).includes(input.role)
    ) {
      return { ok: false, error: `role 必須是:${TEAM_ROLES.join(' / ')}` };
    }
    role = input.role as TeamRole;
  }

  let active = row.active;
  if (input.active !== undefined) {
    active = input.active === true || input.active === 1 || input.active === '1' ? 1 : 0;
  }

  // 自我保护:不可停用/降级自己(否则可能锁死最后一个管理帐号)
  if (id === actingUserId) {
    if (active !== 1) return { ok: false, error: '不可停用自己' };
    if (role !== '管理') return { ok: false, error: '不可降級自己' };
  }

  let passwordHash: string | null = null;
  if (input.password !== undefined) {
    const pwErr = validatePassword(input.password);
    if (pwErr) return { ok: false, error: pwErr };
    passwordHash = bcrypt.hashSync(input.password as string, BCRYPT_ROUNDS);
  }

  updateUserStmt.run(displayName, role, active, passwordHash, id);
  return {
    ok: true,
    user: { id, username: row.username, displayName, role, active, createdAt: row.createdAt },
  };
}

// ---------- 种子帐号 ----------

const countUsersStmt = db.prepare('SELECT COUNT(*) AS n FROM users');

/** users 表为空时建 admin(role=管理),密码取 env ADMIN_INITIAL_PASSWORD(默认 admin123) */
export function seedAdminIfEmpty(log: (msg: string) => void): void {
  const { n } = countUsersStmt.get() as { n: number };
  if (n > 0) return;
  const password = process.env.ADMIN_INITIAL_PASSWORD || 'admin123';
  insertUserStmt.run('admin', '管理員', '管理', bcrypt.hashSync(password, BCRYPT_ROUNDS), Date.now());
  log('users 表為空,已建立初始帳號 admin(role=管理);請立即登入並修改初始密碼');
}
