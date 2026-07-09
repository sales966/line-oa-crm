/**
 * docRoleService.ts — 文件角色分类(缺档补件 + 档案墙分类)。
 * - applyLlmFileRoles:总结后把 LLM 判定的档案角色写入 messages.docRole,
 *   并同步到对应 files.docRole(以 contentHash / lineMessageId 关联);
 *   files.docRoleSource='manual' 的行(人工设定过)不覆盖,人工优先。
 * - setManualFileDocRole:人工在档案墙上直接指派档案角色,锁定 source='manual' 并记 audit。
 * docRole 枚举以 CONTRACT.md 字面值为准:報價單|回簽單|設計圖|刀模|其他。
 */
import db from '../db.js';
import { normalizeDocRole, type DocRole } from '../llm/index.js';
import { recordAudit, type AuditActor } from './auditService.js';
import type { FileRow } from './fileService.js';

/** applyLlmFileRoles 接受的宽松项形状(docRole 会再经 normalizeDocRole 校验) */
export interface LlmFileRoleItem {
  lineMessageId: string;
  docRole: string;
  evidence?: string | null;
}

// messages.docRole 恒以 LLM 判定写入(讯息层无人工/LLM 之分)
const updateMsgDocRoleStmt = db.prepare(
  'UPDATE messages SET docRole = @docRole WHERE lineChatId = @chatId AND lineMessageId = @lineMessageId'
);
const msgContentHashStmt = db.prepare(
  'SELECT contentHash FROM messages WHERE lineChatId = ? AND lineMessageId = ?'
);
// files 同步:以 contentHash 或 lineMessageId 关联;人工设定过(source='manual')不覆盖
const updateFileDocRoleLlmStmt = db.prepare(`
  UPDATE files SET docRole = @docRole, docRoleSource = 'llm'
  WHERE lineChatId = @chatId
    AND (docRoleSource IS NULL OR docRoleSource != 'manual')
    AND (
      (@contentHash IS NOT NULL AND contentHash = @contentHash)
      OR lineMessageId = @lineMessageId
    )
`);

/**
 * 总结阶段用:把 LLM 判定的档案角色写入 messages.docRole,并同步到 files.docRole。
 * 人工设定过角色的 files 行(docRoleSource='manual')不被覆盖。
 * 无法识别为合法 docRole 或缺 lineMessageId 的项一律跳过。
 */
export function applyLlmFileRoles(chatId: string, items: LlmFileRoleItem[]): void {
  if (!Array.isArray(items) || items.length === 0) return;
  const write = db.transaction((rows: LlmFileRoleItem[]) => {
    for (const it of rows) {
      const lineMessageId = typeof it?.lineMessageId === 'string' ? it.lineMessageId.trim() : '';
      if (!lineMessageId) continue;
      const docRole = normalizeDocRole(it?.docRole);
      if (!docRole) continue;

      updateMsgDocRoleStmt.run({ chatId, lineMessageId, docRole });

      const msg = msgContentHashStmt.get(chatId, lineMessageId) as
        | { contentHash: string | null }
        | undefined;
      const contentHash =
        msg && typeof msg.contentHash === 'string' && msg.contentHash ? msg.contentHash : null;

      updateFileDocRoleLlmStmt.run({ chatId, docRole, contentHash, lineMessageId });
    }
  });
  write(items);
}

// ---------- 人工指派档案角色(档案墙) ----------

const fileByIdStmt = db.prepare('SELECT * FROM files WHERE id = ?');
const setManualFileDocRoleStmt = db.prepare(`
  UPDATE files SET docRole = @docRole, docRoleSource = 'manual'
  WHERE id = @fileId AND lineChatId = @chatId
`);

export type SetDocRoleResult =
  | { ok: true; file: FileRow & { downloadUrl: string } }
  | { ok: false; status: number; error: string };

/**
 * 人工设定某档案的角色 docRole(锁定 docRoleSource='manual',LLM 不再覆盖)。
 * docRole 传空/无法识别 → 视为「清除角色」(docRole=null,仍锁定 manual 表示人工已判定为无)。
 * 校验档案存在且属于该 chat;记 file_docrole 审计。
 */
export function setManualFileDocRole(
  chatId: string,
  fileId: number,
  rawDocRole: unknown,
  actor: AuditActor
): SetDocRoleResult {
  if (!Number.isInteger(fileId) || fileId <= 0) {
    return { ok: false, status: 400, error: '无效的档案 id' };
  }
  const existing = fileByIdStmt.get(fileId) as FileRow | undefined;
  if (!existing) return { ok: false, status: 404, error: '档案不存在' };
  if (existing.lineChatId !== chatId) {
    return { ok: false, status: 404, error: '档案不属于此客户' };
  }

  // 允许清除(空字符串/null → docRole=null);否则必须是合法枚举
  const trimmed = typeof rawDocRole === 'string' ? rawDocRole.trim() : rawDocRole;
  let docRole: DocRole | null;
  if (trimmed === '' || trimmed === null || trimmed === undefined) {
    docRole = null;
  } else {
    docRole = normalizeDocRole(trimmed);
    if (!docRole) return { ok: false, status: 400, error: 'docRole 必须为 報價單|回簽單|設計圖|刀模|其他 之一' };
  }

  setManualFileDocRoleStmt.run({ chatId, fileId, docRole });
  recordAudit(chatId, actor, 'file_docrole', String(fileId), {
    docRole,
    prevDocRole: existing.docRole ?? null,
    fileName: existing.fileName ?? null,
  });

  const row = fileByIdStmt.get(fileId) as FileRow;
  return { ok: true, file: { ...row, downloadUrl: `/api/files/${fileId}/download` } };
}
