/**
 * auditService.ts — 步骤纪录(审计日志)。所有关键写操作都调 recordAudit,
 * 让客户详情的「📜 變更紀錄」能显示谁在何时改了阶段/任务/总结/上传档案等。
 */
import db from '../db.js';

export interface AuditActor {
  userId?: number | null;
  userName?: string | null;
}

const insertAuditStmt = db.prepare(`
  INSERT INTO audit_log (lineChatId, userId, userName, action, target, detail, createdAt)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

/**
 * 记一条审计。detail 建议传对象(内部 JSON.stringify);失败不抛(审计不可拖垮主流程)。
 */
export function recordAudit(
  lineChatId: string | null,
  actor: AuditActor,
  action: string,
  target?: string | null,
  detail?: unknown
): void {
  try {
    insertAuditStmt.run(
      lineChatId ?? null,
      actor?.userId ?? null,
      typeof actor?.userName === 'string' ? actor.userName : null,
      action,
      typeof target === 'string' ? target : null,
      detail === undefined || detail === null
        ? null
        : typeof detail === 'string'
          ? detail
          : JSON.stringify(detail),
      Date.now()
    );
  } catch {
    /* 审计写入失败不影响主流程 */
  }
}

export interface AuditRow {
  id: number;
  lineChatId: string | null;
  userId: number | null;
  userName: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  createdAt: number | null;
}

const listAuditStmt = db.prepare(
  'SELECT * FROM audit_log WHERE lineChatId = ? ORDER BY createdAt DESC, id DESC LIMIT ?'
);

export function listAudit(lineChatId: string, limit = 200): AuditRow[] {
  const lim = Math.min(Math.max(Math.trunc(limit) || 200, 1), 1000);
  return listAuditStmt.all(lineChatId, lim) as AuditRow[];
}

export interface AllAuditFilter {
  limit?: number;
  userId?: number | null;
  action?: string | null;
  chatId?: string | null;
}

export interface AllAuditRow {
  id: number;
  userName: string | null;
  userId: number | null;
  action: string;
  target: string | null;
  detail: string | null;
  lineChatId: string | null;
  createdAt: number | null;
}

/**
 * 跨全部客户查 audit_log,支持可选筛选(userId / action / chatId),createdAt 倒序。
 * 全部参数化,limit 夹在 1..1000。
 */
export function listAllAudit(filter: AllAuditFilter = {}): AllAuditRow[] {
  const lim = Math.min(Math.max(Math.trunc(filter.limit ?? 100) || 100, 1), 1000);
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.userId !== undefined && filter.userId !== null && Number.isFinite(filter.userId)) {
    clauses.push('userId = ?');
    params.push(Math.trunc(filter.userId));
  }
  if (typeof filter.action === 'string' && filter.action.trim()) {
    clauses.push('action = ?');
    params.push(filter.action.trim());
  }
  if (typeof filter.chatId === 'string' && filter.chatId.trim()) {
    clauses.push('lineChatId = ?');
    params.push(filter.chatId.trim());
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql =
    `SELECT id, userName, userId, action, target, detail, lineChatId, createdAt ` +
    `FROM audit_log ${where} ORDER BY createdAt DESC, id DESC LIMIT ?`;
  params.push(lim);
  return db.prepare(sql).all(...params) as AllAuditRow[];
}

/** distinct action 清单(供前端筛选下拉),按字母排序 */
export function listAuditActions(): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT action FROM audit_log WHERE action IS NOT NULL AND action <> '' ORDER BY action ASC"
    )
    .all() as { action: string }[];
  return rows.map((r) => r.action);
}

/** 有纪录的 user 清单(供前端筛选下拉),回 {userId, userName} */
export function listAuditUsers(): { userId: number | null; userName: string | null }[] {
  return db
    .prepare(
      `SELECT userId, userName FROM audit_log
       WHERE userId IS NOT NULL OR userName IS NOT NULL
       GROUP BY userId, userName
       ORDER BY userName ASC`
    )
    .all() as { userId: number | null; userName: string | null }[];
}
