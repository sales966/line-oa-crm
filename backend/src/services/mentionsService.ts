/**
 * mentionsService.ts — 内部讨论 @人 / @档案(routes 不直接碰 db)。
 * - insertMentions:随 team_messages 落地结构化 mentions(kind: 'user'|'file')
 * - mentionsForMessages:批量取回讯息的 mentions(含 label,供前端高亮渲染)
 * - listMyMentions / markRead:我被 @ 的通知清单与已读标记(仅 user 提及)
 * - suggest:@ 自动完成(用户 displayName 前缀 + 该 chat 档名匹配)
 * 时间一律 epoch ms。
 */
import db from '../db.js';

export interface MentionView {
  kind: string;
  targetUserId: number | null;
  targetFileId: number | null;
  label: string;
}

const toId = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const insertMentionStmt = db.prepare(`
  INSERT INTO mentions (teamMessageId, lineChatId, kind, targetUserId, targetFileId, readAt, createdAt)
  VALUES (?, ?, ?, ?, ?, NULL, ?)
`);

// 合法性校验:被 @ 的用户须存在;被 @ 的档案须属于该 chat(否则跳过,不抛)
const userExistsStmt = db.prepare(`SELECT 1 FROM users WHERE id = ?`);
const fileInChatStmt = db.prepare(`SELECT 1 FROM files WHERE id = ? AND lineChatId = ?`);

/**
 * 解析并落地一条讨论的 mentions(非法项跳过,不抛)。
 * 校验:targetUserId 须在 users 表存在;targetFileId 须属于该 chat;两者皆忽略非法项。
 */
export function insertMentions(teamMessageId: number, chatId: string, raw: unknown): void {
  if (!Array.isArray(raw) || raw.length === 0) return;
  const now = Date.now();
  const tx = db.transaction((items: unknown[]) => {
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const kind = (it as { kind?: unknown }).kind;
      if (kind === 'user') {
        const uid = toId((it as { targetUserId?: unknown }).targetUserId);
        if (uid == null) continue;
        if (!userExistsStmt.get(uid)) continue; // 用户不存在 → 忽略
        insertMentionStmt.run(teamMessageId, chatId, 'user', uid, null, now);
      } else if (kind === 'file') {
        const fid = toId((it as { targetFileId?: unknown }).targetFileId);
        if (fid == null) continue;
        if (!fileInChatStmt.get(fid, chatId)) continue; // 档案不属于该 chat → 忽略
        insertMentionStmt.run(teamMessageId, chatId, 'file', null, fid, now);
      }
    }
  });
  tx(raw);
}

interface MentionJoinRow {
  teamMessageId: number;
  kind: string;
  targetUserId: number | null;
  targetFileId: number | null;
  userLabel: string | null;
  fileLabel: string | null;
}

/** 批量取回多条讯息的 mentions(含 label);无提及回空 Map。 */
export function mentionsForMessages(ids: number[]): Map<number, MentionView[]> {
  const map = new Map<number, MentionView[]>();
  if (!ids.length) return map;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT mn.teamMessageId, mn.kind, mn.targetUserId, mn.targetFileId,
              u.displayName AS userLabel, f.fileName AS fileLabel
       FROM mentions mn
       LEFT JOIN users u ON mn.kind = 'user' AND u.id = mn.targetUserId
       LEFT JOIN files f ON mn.kind = 'file' AND f.id = mn.targetFileId
       WHERE mn.teamMessageId IN (${placeholders})
       ORDER BY mn.id ASC`
    )
    .all(...ids) as MentionJoinRow[];
  for (const r of rows) {
    const list = map.get(r.teamMessageId) ?? [];
    list.push({
      kind: r.kind,
      targetUserId: r.targetUserId,
      targetFileId: r.targetFileId,
      label: r.kind === 'file' ? r.fileLabel ?? '' : r.userLabel ?? '',
    });
    map.set(r.teamMessageId, list);
  }
  return map;
}

/** 单条讯息的 mentions(新增讯息回传即时用) */
export function mentionsForMessage(id: number): MentionView[] {
  return mentionsForMessages([id]).get(id) ?? [];
}

export interface MyMentionRow {
  id: number;
  lineChatId: string;
  chatName: string | null;
  snippet: string;
  createdAt: number | null;
  readAt: number | null;
}

const myMentionsAllStmt = db.prepare(`
  SELECT mn.id, mn.lineChatId, mn.readAt, mn.createdAt,
         tm.body AS body, c.lineName AS chatName
  FROM mentions mn
  JOIN team_messages tm ON tm.id = mn.teamMessageId
  LEFT JOIN customers c ON c.lineChatId = mn.lineChatId
  WHERE mn.kind = 'user' AND mn.targetUserId = ?
  ORDER BY mn.createdAt DESC, mn.id DESC
  LIMIT 200
`);
const myMentionsUnreadStmt = db.prepare(`
  SELECT mn.id, mn.lineChatId, mn.readAt, mn.createdAt,
         tm.body AS body, c.lineName AS chatName
  FROM mentions mn
  JOIN team_messages tm ON tm.id = mn.teamMessageId
  LEFT JOIN customers c ON c.lineChatId = mn.lineChatId
  WHERE mn.kind = 'user' AND mn.targetUserId = ? AND mn.readAt IS NULL
  ORDER BY mn.createdAt DESC, mn.id DESC
  LIMIT 200
`);

function snippet(body: unknown): string {
  const s = typeof body === 'string' ? body.trim() : '';
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}

/** 我(userId)被 @ 的清单(仅 user 提及);unreadOnly=true 只回未读。 */
export function listMyMentions(userId: number, unreadOnly: boolean): MyMentionRow[] {
  const stmt = unreadOnly ? myMentionsUnreadStmt : myMentionsAllStmt;
  const rows = stmt.all(userId) as (Omit<MyMentionRow, 'snippet'> & { body: string })[];
  return rows.map((r) => ({
    id: r.id,
    lineChatId: r.lineChatId,
    chatName: r.chatName,
    snippet: snippet(r.body),
    createdAt: r.createdAt,
    readAt: r.readAt,
  }));
}

/** 标记我的若干条提及为已读(只动属于我且未读的);回实际更新数。 */
export function markRead(userId: number, ids: unknown): number {
  if (!Array.isArray(ids)) return 0;
  const clean = ids.map(toId).filter((x): x is number => x != null);
  if (!clean.length) return 0;
  const placeholders = clean.map(() => '?').join(',');
  const res = db
    .prepare(
      `UPDATE mentions SET readAt = ?
       WHERE kind = 'user' AND targetUserId = ? AND readAt IS NULL AND id IN (${placeholders})`
    )
    .run(Date.now(), userId, ...clean);
  return res.changes;
}

const escapeLike = (s: string): string => s.replace(/[%_\\]/g, '\\$&');

const suggestUsersPrefixStmt = db.prepare(
  `SELECT id, displayName, role FROM users
   WHERE active = 1 AND displayName LIKE ? ESCAPE '\\'
   ORDER BY displayName ASC LIMIT 8`
);
const suggestUsersAllStmt = db.prepare(
  `SELECT id, displayName, role FROM users WHERE active = 1 ORDER BY displayName ASC LIMIT 8`
);
const suggestFilesMatchStmt = db.prepare(
  `SELECT id, fileName FROM files
   WHERE lineChatId = ? AND fileName LIKE ? ESCAPE '\\'
   ORDER BY COALESCE(uploadedAt, downloadedAt) DESC, id DESC LIMIT 8`
);
const suggestFilesAllStmt = db.prepare(
  `SELECT id, fileName FROM files WHERE lineChatId = ?
   ORDER BY COALESCE(uploadedAt, downloadedAt) DESC, id DESC LIMIT 8`
);

/** @ 自动完成:用户 displayName 前缀匹配 + 该 chat 档名包含匹配。 */
export function suggest(
  chatId: string,
  q: string
): { users: unknown[]; files: unknown[] } {
  const term = (q ?? '').trim();
  const users = term
    ? suggestUsersPrefixStmt.all(escapeLike(term) + '%')
    : suggestUsersAllStmt.all();
  const files = term
    ? suggestFilesMatchStmt.all(chatId, '%' + escapeLike(term) + '%')
    : suggestFilesAllStmt.all(chatId);
  return { users, files };
}
