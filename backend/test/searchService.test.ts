/**
 * searchService.test.ts — 全局搜寻的注入安全与命中/合并不变量(临时库,绝不碰正式 app.db)。
 * escapeLike 与三条 LIKE ... ESCAPE '\' 查询逐字复制自 src/services/searchService.ts,
 * 验证:
 *  - 特殊字元(% _ ' \)当关键字既不报错、也不被当万用字元/注入。
 *  - name / message / summary 三类命中,同客户合并(优先级 name>summary>message)。
 *  - 空/超长 q 由路由层挡(此处验证服务层 escape 行为的等价语义)。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { createTestDb, closeTestDb, type TestDb } from './helpers.js';

// ── 逐字复制自 searchService.ts ────────────────────────────────────────────
const escapeLike = (s: string): string => s.replace(/[%_\\]/g, '\\$&');

const SQL_NAME = `
  SELECT lineChatId, lineName,
         COALESCE(lastMessageAt, updatedAt, createdAt, 0) AS ts
  FROM customers
  WHERE lineName LIKE ? ESCAPE '\\'
  ORDER BY ts DESC
  LIMIT ?
`;
const SQL_SUMMARY = `
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
`;
const SQL_MESSAGE = `
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
`;

const PRIORITY = { name: 3, summary: 2, message: 1 } as const;
type MatchType = keyof typeof PRIORITY;
interface Result {
  lineChatId: string;
  matchType: MatchType;
  timestamp: number;
}

let T: TestDb;
let db: Database.Database;

beforeEach(() => {
  T = createTestDb();
  db = T.db;
});
afterEach(() => closeTestDb(T));

function addCustomer(chatId: string, name: string, ts = Date.now()): void {
  db.prepare('INSERT INTO customers (lineChatId, lineName, lastMessageAt, createdAt) VALUES (?, ?, ?, ?)').run(
    chatId,
    name,
    ts,
    ts
  );
}
function addMessage(chatId: string, text: string, ts = Date.now()): void {
  db.prepare('INSERT INTO messages (lineChatId, direction, msgType, text, timestamp) VALUES (?, ?, ?, ?, ?)').run(
    chatId,
    'in',
    'text',
    text,
    ts
  );
}
function addSummary(chatId: string, summaryText: string, editedText: string | null = null, ts = Date.now()): void {
  db.prepare(
    'INSERT INTO summaries (lineChatId, summaryText, editedText, orderId, createdAt) VALUES (?, ?, ?, 0, ?)'
  ).run(chatId, summaryText, editedText, ts);
}

// search() 的合并语义(逐字复制自 searchService.search):三类候选依优先级合并去重,timestamp 倒序取 limit。
function search(q: string, limit: number): Result[] {
  const like = '%' + escapeLike(q) + '%';
  const byChat = new Map<string, Result>();
  const consider = (r: Result): void => {
    const prev = byChat.get(r.lineChatId);
    if (!prev || PRIORITY[r.matchType] > PRIORITY[prev.matchType]) byChat.set(r.lineChatId, r);
  };
  for (const r of db.prepare(SQL_NAME).all(like, limit) as { lineChatId: string; ts: number }[]) {
    consider({ lineChatId: r.lineChatId, matchType: 'name', timestamp: r.ts ?? 0 });
  }
  for (const r of db.prepare(SQL_SUMMARY).all(like, like, limit) as { lineChatId: string; ts: number }[]) {
    consider({ lineChatId: r.lineChatId, matchType: 'summary', timestamp: r.ts ?? 0 });
  }
  for (const r of db.prepare(SQL_MESSAGE).all(like, limit) as { lineChatId: string; ts: number }[]) {
    consider({ lineChatId: r.lineChatId, matchType: 'message', timestamp: r.ts ?? 0 });
  }
  return Array.from(byChat.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

test('命中 name / message / summary 三类', () => {
  addCustomer('C1', '晶碩包裝', 1000);
  addCustomer('C2', '别家', 2000);
  addMessage('C2', '這批要做燙金紙盒', 2000);
  addCustomer('C3', '第三家', 3000);
  addSummary('C3', '客户想做環保紙袋,已報價', null, 3000);

  assert.deepEqual(search('晶碩', 30).map((r) => r.lineChatId), ['C1']);
  assert.deepEqual(search('燙金', 30).map((r) => r.lineChatId), ['C2']);
  assert.deepEqual(search('環保', 30).map((r) => r.lineChatId), ['C3']);
});

test('同客户多处命中合并:name > summary > message', () => {
  const KW = '限量禮盒';
  addCustomer('C1', `A公司 ${KW}`, 5000); // name 命中
  addMessage('C1', `想做 ${KW}`, 6000); // message 也命中
  addSummary('C1', `重點:${KW}`, null, 7000); // summary 也命中
  const res = search(KW, 30);
  assert.equal(res.length, 1, '同客户只回一条');
  assert.equal(res[0].matchType, 'name', '取最高优先级 name');
});

test('editedText 命中也算 summary(OR editedText LIKE)', () => {
  addCustomer('C9', '無關名', 100);
  addSummary('C9', '原始總結沒有關鍵字', '人工修訂後補上了 特殊訂單', 200);
  assert.deepEqual(search('特殊訂單', 30).map((r) => r.lineChatId), ['C9']);
});

test('特殊字元 % 当字面量:不被当万用字元', () => {
  addCustomer('C1', '折扣 50%off 方案', 1000);
  addCustomer('C2', '完全无关ABCDEF', 2000);
  // 搜 "50%off":% 已 escape,应精确命中 C1,而非因 % 万用匹配到 C2
  assert.deepEqual(search('50%off', 30).map((r) => r.lineChatId), ['C1']);
  // 单独搜 "%":escape 后只匹配真的含 % 的 C1,不匹配所有客户
  assert.deepEqual(search('%', 30).map((r) => r.lineChatId), ['C1']);
});

test('特殊字元 _ 当字面量:不被当单字元万用', () => {
  addCustomer('C1', 'AB_CD 编号', 1000);
  addCustomer('C2', 'ABxCD 编号', 2000);
  // "AB_CD":_ escape 后只命中真的含底线的 C1,不命中 ABxCD
  assert.deepEqual(search('AB_CD', 30).map((r) => r.lineChatId), ['C1']);
});

test("单引号 ' 当关键字:参数化不报错、不注入", () => {
  addCustomer('C1', "O'Brien 訂單", 1000);
  addCustomer('C2', '正常客户', 2000);
  // 经典注入 payload 当关键字:必须当字面量搜、不破坏 SQL、不误删/误查
  assert.doesNotThrow(() => search("'; DROP TABLE customers; --", 30));
  // customers 表仍在、数据完好
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n, 2);
  // 含单引号的关键字能正常命中
  assert.deepEqual(search("O'Brien", 30).map((r) => r.lineChatId), ['C1']);
});

test('反斜线 \\ 当关键字:escape 后当字面量,不报错', () => {
  addCustomer('C1', '路徑 C:\\temp 檔', 1000);
  assert.doesNotThrow(() => search('C:\\temp', 30));
  assert.deepEqual(search('C:\\temp', 30).map((r) => r.lineChatId), ['C1']);
});

test('limit 边界:每类候选受 limit 限制,合并后取前 limit', () => {
  for (let i = 0; i < 5; i++) addCustomer(`M${i}`, `共同關鍵 客户${i}`, 1000 + i);
  assert.equal(search('共同關鍵', 2).length, 2, 'limit=2 只回 2 条');
  assert.equal(search('共同關鍵', 30).length, 5);
});

test('无命中关键字回空', () => {
  addCustomer('C1', '只有這個', 1000);
  assert.deepEqual(search('绝不存在的词xyz', 30), []);
});
