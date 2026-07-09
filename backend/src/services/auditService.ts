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
