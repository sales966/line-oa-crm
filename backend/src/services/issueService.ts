/**
 * issueService.ts — 问题回报(同仁回报系统问题,管理员处理;routes 不直接碰 db)。
 * - createIssue:任何登入者回报,记 reporter(userId/displayName/role)
 * - listIssues:管理員看全部,非管理員只看自己回报的(reporterUserId=自己),倒序
 * - updateIssue:仅管理員可改 status/adminNote;status 限 open/in_progress/closed
 * - countOpen:管理員未处理(status='open')数
 * 关键写操作统一 recordAudit('issue_*')。时间一律 epoch ms。
 */
import db from '../db.js';
import { recordAudit } from './auditService.js';
import type { SessionUser } from './authService.js';

/** status 白名单(与契约一致) */
export const ISSUE_STATUSES = ['open', 'in_progress', 'closed'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export interface IssueRow {
  id: number;
  reporterUserId: number | null;
  reporterName: string | null;
  reporterRole: string | null;
  lineChatId: string | null;
  title: string;
  body: string | null;
  status: string;
  adminNote: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

const insertIssueStmt = db.prepare(`
  INSERT INTO issues (reporterUserId, reporterName, reporterRole, lineChatId, title, body, status, adminNote, createdAt, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)
`);

const getIssueStmt = db.prepare('SELECT * FROM issues WHERE id = ?');

export type CreateIssueResult =
  | { ok: true; issue: IssueRow }
  | { ok: false; error: string };

/**
 * 新增问题回报:title 去空白后不得为空;reporter 由 route 从 session user 提供。
 * lineChatId 选填(在某客户页回报时带上)。
 */
export function createIssue(
  actor: SessionUser,
  input: { title?: unknown; body?: unknown; lineChatId?: unknown }
): CreateIssueResult {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) return { ok: false, error: 'title 不得為空' };
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  const lineChatId =
    typeof input.lineChatId === 'string' && input.lineChatId.trim() ? input.lineChatId.trim() : null;

  const now = Date.now();
  const res = insertIssueStmt.run(
    actor.id,
    actor.displayName,
    actor.role,
    lineChatId,
    title,
    body || null,
    now,
    now
  );
  const id = Number(res.lastInsertRowid);
  const issue = getIssueStmt.get(id) as IssueRow;

  recordAudit(lineChatId, { userId: actor.id, userName: actor.displayName }, 'issue_create', String(id), {
    title,
  });

  return { ok: true, issue };
}

const listAllStmt = db.prepare('SELECT * FROM issues ORDER BY createdAt DESC, id DESC');
const listMineStmt = db.prepare(
  'SELECT * FROM issues WHERE reporterUserId = ? ORDER BY createdAt DESC, id DESC'
);

/** 管理員看全部;非管理員只看自己回报的。倒序(最新在前)。 */
export function listIssues(user: SessionUser): IssueRow[] {
  if (user.role === '管理') return listAllStmt.all() as IssueRow[];
  return listMineStmt.all(user.id) as IssueRow[];
}

const updateIssueStmt = db.prepare(
  'UPDATE issues SET status = ?, adminNote = ?, updatedAt = ? WHERE id = ?'
);

export type UpdateIssueResult =
  | { ok: true; issue: IssueRow }
  | { ok: false; error: string; forbidden?: boolean; notFound?: boolean };

/**
 * 更新问题:仅管理員;status(若给)须为 open/in_progress/closed。
 * status/adminNote 均选填,未给则保留原值(adminNote 显式传空字符串则清空)。
 */
export function updateIssue(
  id: number,
  input: { status?: unknown; adminNote?: unknown },
  actor: SessionUser
): UpdateIssueResult {
  if (!actor || actor.role !== '管理') return { ok: false, error: '僅限管理角色', forbidden: true };
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'id 不合法' };

  const existing = getIssueStmt.get(id) as IssueRow | undefined;
  if (!existing) return { ok: false, error: '問題不存在', notFound: true };

  let status = existing.status;
  if (input.status !== undefined) {
    if (!ISSUE_STATUSES.includes(input.status as IssueStatus)) {
      return { ok: false, error: 'status 不合法(open/in_progress/closed)' };
    }
    status = input.status as IssueStatus;
  }

  let adminNote = existing.adminNote;
  if (input.adminNote !== undefined) {
    adminNote = typeof input.adminNote === 'string' ? input.adminNote.trim() || null : null;
  }

  const now = Date.now();
  updateIssueStmt.run(status, adminNote, now, id);
  const issue = getIssueStmt.get(id) as IssueRow;

  recordAudit(
    existing.lineChatId,
    { userId: actor.id, userName: actor.displayName },
    'issue_update',
    String(id),
    { from: { status: existing.status, adminNote: existing.adminNote }, to: { status, adminNote } }
  );

  return { ok: true, issue };
}

const countOpenStmt = db.prepare("SELECT COUNT(*) AS n FROM issues WHERE status = 'open'");

/** 管理員未处理(status='open')数。 */
export function countOpen(): number {
  const row = countOpenStmt.get() as { n: number };
  return row?.n ?? 0;
}
