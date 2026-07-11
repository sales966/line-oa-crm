/**
 * auditAll.test.ts — auditService.listAllAudit 的筛选/排序/limit 不变量(临时库,绝不碰正式 app.db)。
 * listAllAudit 的动态 SQL 组合逻辑逐字复制自 src/services/auditService.ts,验证:
 *  - userId / action / chatId 筛选参数化且正确(含可组合)。
 *  - createdAt 倒序(同 createdAt 以 id 倒序稳定)。
 *  - limit 夹在 1..1000,默认 100;非法值回落默认。
 *  - 注入型 action 值当字面量比对,不破坏查询、不误返回全部。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { createTestDb, closeTestDb, type TestDb } from './helpers.js';

let T: TestDb;
let db: Database.Database;

beforeEach(() => {
  T = createTestDb();
  db = T.db;
});
afterEach(() => closeTestDb(T));

interface Filter {
  limit?: number;
  userId?: number | null;
  action?: string | null;
  chatId?: string | null;
}

// listAllAudit(逐字复制 src/services/auditService.ts 的组合逻辑,db 换成临时库)
function listAllAudit(filter: Filter = {}): { id: number; action: string; userId: number | null; lineChatId: string | null; createdAt: number | null }[] {
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
  return db.prepare(sql).all(...params) as never;
}

let seq = 0;
function addAudit(opts: {
  chatId?: string | null;
  userId?: number | null;
  userName?: string | null;
  action: string;
  createdAt?: number;
}): void {
  db.prepare(
    'INSERT INTO audit_log (lineChatId, userId, userName, action, target, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    opts.chatId ?? null,
    opts.userId ?? null,
    opts.userName ?? null,
    opts.action,
    null,
    null,
    opts.createdAt ?? 1000 + seq++
  );
}

test('筛选 userId:只回该用户的纪录(参数化)', () => {
  addAudit({ userId: 1, action: 'stage_change' });
  addAudit({ userId: 2, action: 'tag_set' });
  addAudit({ userId: 1, action: 'tag_create' });
  const rows = listAllAudit({ userId: 1 });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.userId === 1));
});

test('筛选 action:精确等值(不是 LIKE),参数化', () => {
  addAudit({ action: 'tag_create' });
  addAudit({ action: 'tag_set' });
  addAudit({ action: 'tag_create' });
  const rows = listAllAudit({ action: 'tag_create' });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.action === 'tag_create'));
  // 'tag' 不该模糊命中 tag_create/tag_set
  assert.equal(listAllAudit({ action: 'tag' }).length, 0);
});

test('筛选 chatId:只回该客户的纪录', () => {
  addAudit({ chatId: 'CA', action: 'x' });
  addAudit({ chatId: 'CB', action: 'x' });
  addAudit({ chatId: 'CA', action: 'y' });
  const rows = listAllAudit({ chatId: 'CA' });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.lineChatId === 'CA'));
});

test('筛选可组合:userId + action + chatId 同时生效(AND)', () => {
  addAudit({ userId: 1, chatId: 'CA', action: 'tag_set' });
  addAudit({ userId: 1, chatId: 'CA', action: 'tag_create' }); // action 不符
  addAudit({ userId: 2, chatId: 'CA', action: 'tag_set' }); // userId 不符
  addAudit({ userId: 1, chatId: 'CB', action: 'tag_set' }); // chatId 不符
  const rows = listAllAudit({ userId: 1, chatId: 'CA', action: 'tag_set' });
  assert.equal(rows.length, 1);
});

test('无筛选:回全部,createdAt 倒序(同 createdAt 以 id 倒序)', () => {
  addAudit({ action: 'a', createdAt: 100 });
  addAudit({ action: 'b', createdAt: 300 });
  addAudit({ action: 'c', createdAt: 200 });
  // 同 createdAt 两条,验证 id 倒序 tie-break
  addAudit({ action: 'd', createdAt: 300 });
  const rows = listAllAudit();
  const times = rows.map((r) => r.createdAt);
  // createdAt 非升序
  for (let i = 1; i < times.length; i++) assert.ok((times[i - 1] ?? 0) >= (times[i] ?? 0));
  // 两条 createdAt=300 的,后插入(id 大)的排前
  const at300 = rows.filter((r) => r.createdAt === 300).map((r) => r.action);
  assert.deepEqual(at300, ['d', 'b'], '同 createdAt 以 id 倒序');
});

test('limit:夹在 1..1000,默认 100', () => {
  for (let i = 0; i < 5; i++) addAudit({ action: `a${i}` });
  assert.equal(listAllAudit({ limit: 2 }).length, 2);
  // limit=0 → || 100 回落默认(此处纪录仅 5 条,取全部 5)
  assert.equal(listAllAudit({ limit: 0 }).length, 5);
  // limit 负数 → clamp 到 1
  assert.equal(listAllAudit({ limit: -3 }).length, 1);
  // 超大 → clamp 1000(纪录只有 5,取 5)
  assert.equal(listAllAudit({ limit: 999999 }).length, 5);
});

test('注入型 action 值当字面量比对,不返回全部、不报错', () => {
  addAudit({ action: 'tag_create' });
  addAudit({ action: 'stage_change' });
  const rows = listAllAudit({ action: "x' OR '1'='1" });
  assert.equal(rows.length, 0, '注入 payload 当字面 action,查无此值');
  // 表数据完好
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n, 2);
});
