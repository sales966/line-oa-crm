/**
 * tagService.test.ts — 客户标签业务不变量(临时库,绝不碰正式 app.db)。
 * SQL 逐字复制自 src/services/tagService.ts 与 chatService.listCustomers 的 tagId 分支,
 * 在临时库上跑相同语义,验证:
 *  1. createTag 同名去重(唯一 name,幂等回既有)。
 *  2. setCustomerTags 整批覆盖(先[1,2]再[2,3]→只剩2,3,不残留1)。
 *  3. deleteTag 连带清 customer_tags。
 *  4. listCustomers ?tagId 只回贴该标签的客户。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { createTestDb, closeTestDb, type TestDb } from './helpers.js';

// ── 逐字复制自 tagService.ts 的 SQL ────────────────────────────────────────
const SQL_TAG_GET_BY_NAME = 'SELECT id, name, color, createdAt FROM tags WHERE name = ?';
const SQL_TAG_INSERT = 'INSERT INTO tags (name, color, createdAt) VALUES (?, ?, ?)';
const SQL_TAG_DELETE = 'DELETE FROM tags WHERE id = ?';
const SQL_TAG_DELETE_LINKS = 'DELETE FROM customer_tags WHERE tagId = ?';
const SQL_CT_DELETE_ALL = 'DELETE FROM customer_tags WHERE lineChatId = ?';
const SQL_CT_INSERT = 'INSERT OR IGNORE INTO customer_tags (lineChatId, tagId, createdAt) VALUES (?, ?, ?)';
const SQL_TAG_EXISTS = 'SELECT 1 FROM tags WHERE id = ?';
const SQL_GET_CUSTOMER_TAGS = `
  SELECT t.id, t.name, t.color
  FROM customer_tags ct
  JOIN tags t ON t.id = ct.tagId
  WHERE ct.lineChatId = ?
  ORDER BY t.name ASC, t.id ASC
`;
// chatService.listCustomers 的 tagId 分支(EXISTS 子查询,参数化)
const SQL_LIST_BY_TAG = `
  SELECT c.lineChatId FROM customers c
  WHERE EXISTS (SELECT 1 FROM customer_tags ct WHERE ct.lineChatId = c.lineChatId AND ct.tagId = ?)
  ORDER BY c.lineChatId ASC
`;

let T: TestDb;
let db: Database.Database;

beforeEach(() => {
  T = createTestDb();
  db = T.db;
});
afterEach(() => closeTestDb(T));

const norm = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// tagService.createTag 语义:name 空→error;同名→回既有(dedup);否则新建。
function createTag(name: unknown, color: string | null = null): { id: number; dedup: boolean } | { error: string } {
  const nm = norm(name);
  if (!nm) return { error: '缺少标签名称' };
  const existing = db.prepare(SQL_TAG_GET_BY_NAME).get(nm) as { id: number } | undefined;
  if (existing) return { id: existing.id, dedup: true };
  const res = db.prepare(SQL_TAG_INSERT).run(nm, color, Date.now());
  return { id: Number(res.lastInsertRowid), dedup: false };
}

// tagService.setCustomerTags 语义:解析成合法正整数集合(去重),整批覆盖,只写存在的标签。
function setCustomerTags(chatId: string, tagIds: unknown): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  if (Array.isArray(tagIds)) {
    for (const raw of tagIds) {
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
        seen.add(n);
        ids.push(n);
      }
    }
  }
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(SQL_CT_DELETE_ALL).run(chatId);
    for (const id of ids) {
      if (db.prepare(SQL_TAG_EXISTS).get(id)) db.prepare(SQL_CT_INSERT).run(chatId, id, now);
    }
  });
  tx();
  return (db.prepare(SQL_GET_CUSTOMER_TAGS).all(chatId) as { id: number }[]).map((r) => r.id);
}

function deleteTag(id: number): void {
  const tx = db.transaction(() => {
    db.prepare(SQL_TAG_DELETE_LINKS).run(id);
    db.prepare(SQL_TAG_DELETE).run(id);
  });
  tx();
}

test('createTag:同名去重,只留一行、回既有 id(幂等)', () => {
  const a = createTag('急件', '#f00') as { id: number; dedup: boolean };
  assert.equal(a.dedup, false);
  const b = createTag('急件', '#00f') as { id: number; dedup: boolean };
  assert.equal(b.dedup, true, '同名应视为去重命中');
  assert.equal(b.id, a.id, '回既有 id');
  const cnt = (db.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }).n;
  assert.equal(cnt, 1, 'tags 只应有一行');
  // color 不被第二次呼叫覆盖(dedup 不写)
  const row = db.prepare('SELECT color FROM tags WHERE id = ?').get(a.id) as { color: string };
  assert.equal(row.color, '#f00');
});

test('createTag:name trim 后为空 → error,不建行', () => {
  const r = createTag('   ');
  assert.ok('error' in r);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }).n, 0);
});

test('createTag:UNIQUE(name) 硬约束确实存在', () => {
  createTag('VIP');
  assert.throws(() => db.prepare(SQL_TAG_INSERT).run('VIP', null, Date.now()), /UNIQUE/);
});

test('setCustomerTags:整批覆盖,先[1,2]再[2,3]→只剩2,3(不残留1)', () => {
  const t1 = (createTag('t1') as { id: number }).id;
  const t2 = (createTag('t2') as { id: number }).id;
  const t3 = (createTag('t3') as { id: number }).id;
  const CHAT = 'Ctag-cust';
  assert.deepEqual(setCustomerTags(CHAT, [t1, t2]).sort(), [t1, t2].sort());
  const after = setCustomerTags(CHAT, [t2, t3]).sort();
  assert.deepEqual(after, [t2, t3].sort(), '覆盖后只剩 2,3');
  const has1 = db.prepare('SELECT 1 FROM customer_tags WHERE lineChatId = ? AND tagId = ?').get(CHAT, t1);
  assert.equal(has1, undefined, 't1 关联应被清掉');
});

test('setCustomerTags:去重、忽略不存在的 id、清空传空数组', () => {
  const t1 = (createTag('a') as { id: number }).id;
  const CHAT = 'Ctag-dup';
  // 重复 t1、混入不存在的 9999
  assert.deepEqual(setCustomerTags(CHAT, [t1, t1, 9999]), [t1], '去重且只写存在标签');
  // 传空 → 清空
  assert.deepEqual(setCustomerTags(CHAT, []), []);
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM customer_tags WHERE lineChatId = ?').get(CHAT) as { n: number };
  assert.equal(cnt.n, 0);
});

test('deleteTag:连带清 customer_tags(不留悬挂关联)', () => {
  const t1 = (createTag('x') as { id: number }).id;
  const t2 = (createTag('y') as { id: number }).id;
  setCustomerTags('CA', [t1, t2]);
  setCustomerTags('CB', [t1]);
  deleteTag(t1);
  const tagGone = db.prepare('SELECT COUNT(*) AS n FROM tags WHERE id = ?').get(t1) as { n: number };
  assert.equal(tagGone.n, 0, '标签定义应被删');
  const links = db.prepare('SELECT COUNT(*) AS n FROM customer_tags WHERE tagId = ?').get(t1) as { n: number };
  assert.equal(links.n, 0, 't1 的所有关联应被清');
  // t2 不受影响
  const t2links = db.prepare('SELECT COUNT(*) AS n FROM customer_tags WHERE tagId = ?').get(t2) as { n: number };
  assert.equal(t2links.n, 1, 't2 关联保留');
});

test('listCustomers ?tagId:只回贴了该标签的客户', () => {
  const now = Date.now();
  for (const c of ['C1', 'C2', 'C3']) {
    db.prepare('INSERT INTO customers (lineChatId, createdAt) VALUES (?, ?)').run(c, now);
  }
  const vip = (createTag('VIP') as { id: number }).id;
  const other = (createTag('普通') as { id: number }).id;
  setCustomerTags('C1', [vip]);
  setCustomerTags('C2', [vip, other]);
  setCustomerTags('C3', [other]);
  const vipCusts = (db.prepare(SQL_LIST_BY_TAG).all(vip) as { lineChatId: string }[]).map((r) => r.lineChatId);
  assert.deepEqual(vipCusts, ['C1', 'C2'], 'tagId=VIP 只回 C1,C2');
  const otherCusts = (db.prepare(SQL_LIST_BY_TAG).all(other) as { lineChatId: string }[]).map((r) => r.lineChatId);
  assert.deepEqual(otherCusts, ['C2', 'C3']);
  // 不存在的 tagId → 空
  assert.equal((db.prepare(SQL_LIST_BY_TAG).all(999999) as unknown[]).length, 0);
});
