/**
 * searchService.ts — 全局搜寻(routes 不直接碰 db)。
 * 跨三处以 LIKE '%q%' 搜寻(参数化,防注入):
 *   - customers.lineName            → matchType 'name'
 *   - summaries.summaryText/editedText → matchType 'summary'(每客户取最新一条)
 *   - messages.text                 → matchType 'message'(每客户取最新一条)
 * 同一客户多处命中合并,优先级 name > summary > message;结果按 timestamp 倒序,限 limit。
 * snippet:命中处前后各 20 字(不区分大小写定位),超出两端补省略号。
 * 时间一律 epoch ms。
 */
import db from '../db.js';

export type MatchType = 'name' | 'message' | 'summary';

export interface SearchResult {
  lineChatId: string;
  customerName: string;
  matchType: MatchType;
  snippet: string;
  timestamp: number;
}

/** LIKE 特殊字元转义,配合 ESCAPE '\' 使 %/_/\ 作字面量。 */
const escapeLike = (s: string): string => s.replace(/[%_\\]/g, '\\$&');

const SNIPPET_PAD = 20;

/** 取命中处前后各 20 字的片段;找不到命中(理论上不会)则回退截前 60 字。 */
function makeSnippet(text: unknown, q: string): string {
  const s = typeof text === 'string' ? text : '';
  if (!s) return '';
  const idx = s.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return s.length > 60 ? s.slice(0, 60) + '…' : s;
  const start = Math.max(0, idx - SNIPPET_PAD);
  const end = Math.min(s.length, idx + q.length + SNIPPET_PAD);
  let snip = s.slice(start, end);
  if (start > 0) snip = '…' + snip;
  if (end < s.length) snip = snip + '…';
  return snip;
}

// 各类命中每客户取最新一条:SQLite 对 MIN/MAX 聚合会连带回传同行其他裸列(bare columns),
// 故 GROUP BY lineChatId + MAX(时间) 即拿到该客户最新命中行的文本。
const nameStmt = db.prepare(`
  SELECT lineChatId, lineName,
         COALESCE(lastMessageAt, updatedAt, createdAt, 0) AS ts
  FROM customers
  WHERE lineName LIKE ? ESCAPE '\\'
  ORDER BY ts DESC
  LIMIT ?
`);

const summaryStmt = db.prepare(`
  SELECT s.lineChatId AS lineChatId,
         s.summaryText AS summaryText,
         s.editedText AS editedText,
         MAX(COALESCE(s.editedAt, s.createdAt, 0)) AS ts,
         c.lineName AS lineName
  FROM summaries s
  LEFT JOIN customers c ON c.lineChatId = s.lineChatId
  WHERE s.summaryText LIKE ? ESCAPE '\\' OR s.editedText LIKE ? ESCAPE '\\'
  GROUP BY s.lineChatId
  ORDER BY ts DESC
  LIMIT ?
`);

const messageStmt = db.prepare(`
  SELECT m.lineChatId AS lineChatId,
         m.text AS text,
         MAX(m.timestamp) AS ts,
         c.lineName AS lineName
  FROM messages m
  LEFT JOIN customers c ON c.lineChatId = m.lineChatId
  WHERE m.text LIKE ? ESCAPE '\\'
  GROUP BY m.lineChatId
  ORDER BY ts DESC
  LIMIT ?
`);

interface NameRow {
  lineChatId: string;
  lineName: string | null;
  ts: number;
}
interface SummaryRow {
  lineChatId: string;
  summaryText: string | null;
  editedText: string | null;
  ts: number;
  lineName: string | null;
}
interface MessageRow {
  lineChatId: string;
  text: string | null;
  ts: number;
  lineName: string | null;
}

// 合并优先级:name(3) > summary(2) > message(1);同客户仅保留最高优先级那条。
const PRIORITY: Record<MatchType, number> = { name: 3, summary: 2, message: 1 };

/**
 * 全局搜寻。q 须已 trim 且非空(路由层已保证);limit 由路由夹在 1..30。
 * 每类先取最新 limit 条候选,再依优先级合并去重,最后按 timestamp 倒序取前 limit。
 */
export function search(q: string, limit: number): SearchResult[] {
  const like = '%' + escapeLike(q) + '%';
  const byChat = new Map<string, SearchResult>();

  const consider = (r: SearchResult): void => {
    const prev = byChat.get(r.lineChatId);
    if (!prev || PRIORITY[r.matchType] > PRIORITY[prev.matchType]) {
      byChat.set(r.lineChatId, r);
    }
  };

  // name
  for (const r of nameStmt.all(like, limit) as NameRow[]) {
    consider({
      lineChatId: r.lineChatId,
      customerName: r.lineName ?? '',
      matchType: 'name',
      snippet: r.lineName ?? '',
      timestamp: r.ts ?? 0,
    });
  }

  // summary(editedText 命中优先取 editedText 片段,否则 summaryText)
  for (const r of summaryStmt.all(like, like, limit) as SummaryRow[]) {
    const editedHit =
      typeof r.editedText === 'string' &&
      r.editedText.toLowerCase().includes(q.toLowerCase());
    const src = editedHit ? r.editedText : r.summaryText;
    consider({
      lineChatId: r.lineChatId,
      customerName: r.lineName ?? '',
      matchType: 'summary',
      snippet: makeSnippet(src, q),
      timestamp: r.ts ?? 0,
    });
  }

  // message
  for (const r of messageStmt.all(like, limit) as MessageRow[]) {
    consider({
      lineChatId: r.lineChatId,
      customerName: r.lineName ?? '',
      matchType: 'message',
      snippet: makeSnippet(r.text, q),
      timestamp: r.ts ?? 0,
    });
  }

  return Array.from(byChat.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}
