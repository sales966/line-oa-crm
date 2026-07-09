/**
 * summaryEditService.ts — AI 总结的人工编辑 / 批注(routes 不直接碰 db)。
 * - editSummary:人工修改总结版本(存 editedText、editedBy 系列、editedAt);editedText 传空=还原(清空)。
 * - addAnnotation / listAnnotations:在总结旁附加批注(不改原文)。
 * 所有写操作都调 recordAudit(带 session user)记入 audit_log。
 * 注:不改 summaryService.ts(那是产生 AI 总结的模块);重新生成 AI 总结另存新行,不覆盖 editedText。
 */
import db from '../db.js';
import { recordAudit, type AuditActor } from './auditService.js';

/** 编辑/批注的操作者身份(由 route 从 session user 提供) */
export interface EditActor {
  userId?: number | null;
  userName?: string | null;
}

function toAuditActor(actor: EditActor): AuditActor {
  return {
    userId: actor?.userId ?? null,
    userName: typeof actor?.userName === 'string' ? actor.userName : null,
  };
}

/** 取一条 summary(限定同 chatId,避免跨客户误改) */
const getSummaryStmt = db.prepare(
  'SELECT * FROM summaries WHERE id = ? AND lineChatId = ?'
);

interface SummaryRow {
  id: number;
  lineChatId: string;
  summaryText: string | null;
  editedText: string | null;
  editedByUserId: number | null;
  editedByName: string | null;
  editedAt: number | null;
}

const applyEditStmt = db.prepare(`
  UPDATE summaries
     SET editedText = ?, editedByUserId = ?, editedByName = ?, editedAt = ?
   WHERE id = ? AND lineChatId = ?
`);

export type EditSummaryResult =
  | { ok: true; summary: SummaryRow }
  | { ok: false; status: number; error: string };

/**
 * 人工编辑总结:editedText 非空=存人工修改版;传空(去空白后为空/未提供)=还原,
 * 清空 editedText 及编辑者/时间。两种情况都记 audit(summary_edit)。
 */
export function editSummary(
  chatId: string,
  summaryId: number,
  editedText: unknown,
  actor: EditActor
): EditSummaryResult {
  if (!chatId) return { ok: false, status: 400, error: '缺少 chatId' };
  if (!Number.isFinite(summaryId)) return { ok: false, status: 400, error: 'summaryId 无效' };

  const existing = getSummaryStmt.get(summaryId, chatId) as SummaryRow | undefined;
  if (!existing) return { ok: false, status: 404, error: '总结不存在' };

  const trimmed = typeof editedText === 'string' ? editedText.trim() : '';
  const isRevert = trimmed === '';
  const now = Date.now();

  if (isRevert) {
    applyEditStmt.run(null, null, null, null, summaryId, chatId);
  } else {
    applyEditStmt.run(trimmed, actor?.userId ?? null, actor?.userName ?? null, now, summaryId, chatId);
  }

  recordAudit(chatId, toAuditActor(actor), 'summary_edit', String(summaryId), {
    summaryId,
    revert: isRevert,
    length: isRevert ? 0 : trimmed.length,
  });

  const updated = getSummaryStmt.get(summaryId, chatId) as SummaryRow;
  return { ok: true, summary: updated };
}

/* ---------- 批注(不改原文) ---------- */

export interface AnnotationShape {
  id: number;
  lineChatId: string;
  summaryId: number;
  userId: number | null;
  userName: string | null;
  body: string;
  createdAt: number;
}

const summaryExistsStmt = db.prepare(
  'SELECT id FROM summaries WHERE id = ? AND lineChatId = ?'
);

const insertAnnotationStmt = db.prepare(`
  INSERT INTO summary_annotations (lineChatId, summaryId, userId, userName, body, createdAt)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const listAnnotationsStmt = db.prepare(
  `SELECT id, lineChatId, summaryId, userId, userName, body, createdAt
     FROM summary_annotations
    WHERE lineChatId = ? AND summaryId = ?
    ORDER BY createdAt ASC, id ASC`
);

export type AddAnnotationResult =
  | { ok: true; annotation: AnnotationShape }
  | { ok: false; status: number; error: string };

/** 加批注:body 去空白后不得为空;记 audit(summary_annotate) */
export function addAnnotation(
  chatId: string,
  summaryId: number,
  body: unknown,
  actor: EditActor
): AddAnnotationResult {
  if (!chatId) return { ok: false, status: 400, error: '缺少 chatId' };
  if (!Number.isFinite(summaryId)) return { ok: false, status: 400, error: 'summaryId 无效' };

  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) return { ok: false, status: 400, error: 'body 不得為空' };

  const exists = summaryExistsStmt.get(summaryId, chatId);
  if (!exists) return { ok: false, status: 404, error: '总结不存在' };

  const now = Date.now();
  const res = insertAnnotationStmt.run(
    chatId,
    summaryId,
    actor?.userId ?? null,
    actor?.userName ?? null,
    text,
    now
  );

  recordAudit(chatId, toAuditActor(actor), 'summary_annotate', String(summaryId), {
    summaryId,
    annotationId: Number(res.lastInsertRowid),
  });

  return {
    ok: true,
    annotation: {
      id: Number(res.lastInsertRowid),
      lineChatId: chatId,
      summaryId,
      userId: actor?.userId ?? null,
      userName: typeof actor?.userName === 'string' ? actor.userName : null,
      body: text,
      createdAt: now,
    },
  };
}

/** 列某总结的全部批注(时间正序) */
export function listAnnotations(chatId: string, summaryId: number): AnnotationShape[] {
  if (!chatId || !Number.isFinite(summaryId)) return [];
  return listAnnotationsStmt.all(chatId, summaryId) as AnnotationShape[];
}
