/**
 * teamChatService.ts — 团队内部讨论(客户不可见;routes 不直接碰 db)。
 * 时间一律 epoch ms;createdAt 由 backend 写入,与 id 单调同序。
 */
import db from '../db.js';
import { PAGE_LIMIT_MAX } from '../config.js';
import * as mentionsService from './mentionsService.js';
import type { MentionView } from './mentionsService.js';
import { recordAudit } from './auditService.js';

/** authorRole 白名单(契约四值,繁体字面值,与 db CHECK 约束一致) */
export const TEAM_ROLES = ['跟單', '設計', '客服', '管理'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export interface TeamMessageShape {
  id: number;
  authorName: string;
  authorRole: TeamRole;
  body: string;
  createdAt: number;
  mentions?: MentionView[];
}

const toInt = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const listTeamMsgsStmt = db.prepare(
  `SELECT id, authorName, authorRole, body, createdAt FROM team_messages
   WHERE lineChatId = ? AND id > ? ORDER BY id ASC LIMIT ?`
);

/**
 * id 升序;after=上次最大 id(增量轮询用),只回 id > after 的。
 * 排序键与游标键统一用 id(AUTOINCREMENT 即写入顺序,createdAt 与 id 同序,显示不变):
 * 若按 createdAt 排序,时钟回拨使两者失序且 LIMIT 恰好截断在失序行之间时,
 * 客户端游标会越过较小 id 的行,永久漏消息。
 */
export function listTeamMessages(
  chatId: string,
  opts: { after?: number; limit?: number } = {}
): TeamMessageShape[] {
  const limit = Math.min(Math.max(toInt(opts.limit) ?? 100, 1), PAGE_LIMIT_MAX);
  const after = toInt(opts.after) ?? 0;
  const rows = listTeamMsgsStmt.all(chatId, after, limit) as TeamMessageShape[];
  // 附上结构化 mentions(含 label,供前端高亮 @人/@档案)
  const byMsg = mentionsService.mentionsForMessages(rows.map((r) => r.id));
  for (const r of rows) r.mentions = byMsg.get(r.id) ?? [];
  return rows;
}

const insertTeamMsgStmt = db.prepare(`
  INSERT INTO team_messages (lineChatId, authorName, authorRole, userId, body, createdAt)
  VALUES (?, ?, ?, ?, ?, ?)
`);

export type AddTeamMessageResult =
  | { ok: true; message: TeamMessageShape }
  | { ok: false; error: string };

/**
 * 新增讨论:body 去空白后不得为空(不合法由 route 回 400)。
 * 发言人身份(authorName/authorRole/userId)由 route 从 session user 强制提供,
 * body 里前端送的同名字段一律忽略(API 形状兼容)。
 */
export function addTeamMessage(
  chatId: string,
  input: { body?: unknown; mentions?: unknown },
  author: { userId: number; name: string; role: TeamRole }
): AddTeamMessageResult {
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) return { ok: false, error: 'body 不得為空' };

  const now = Date.now();
  const res = insertTeamMsgStmt.run(chatId, author.name, author.role, author.userId, body, now);
  const id = Number(res.lastInsertRowid);

  // 结构化 mentions(@人/@档案)落地;非法项由 service 内部跳过
  mentionsService.insertMentions(id, chatId, input.mentions);
  const mentions = mentionsService.mentionsForMessage(id);
  // 有提及即记审计(@人/@档案 属可追踪写操作)
  if (mentions.length) {
    recordAudit(chatId, { userId: author.userId, userName: author.name }, 'team_mention', String(id), {
      mentions: mentions.map((m) => ({ kind: m.kind, targetUserId: m.targetUserId, targetFileId: m.targetFileId })),
    });
  }

  return {
    ok: true,
    message: {
      id,
      authorName: author.name,
      authorRole: author.role,
      body,
      createdAt: now,
      mentions,
    },
  };
}
