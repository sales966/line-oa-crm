/**
 * dashboardReminders.test.ts — reminders() 新增两类判定不变量(临时库,绝不碰正式 app.db)。
 * pendingBuildStmt / noSummaryStmt 逐字复制自 src/services/dashboardService.ts,验证:
 *  - pending-build:sync_requests.status='pending' 才提醒(done/error 不提醒)。
 *  - no-summary:有对话(messages)但 summaries 从未有任何一条,且非「流失」才提醒。
 *  - 已总结客户 / 流失客户 / 无对话客户不误报。
 *  - 两类查询彼此独立,不干扰既有 deadline 类(deadline 仍由 stage_meta.deadlineAt 判定)。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { createTestDb, closeTestDb, type TestDb } from './helpers.js';

// ── 逐字复制自 dashboardService.ts ─────────────────────────────────────────
const SQL_PENDING_BUILD = `
  SELECT sr.lineChatId AS lineChatId, c.lineName AS lineName, c.currentStage AS currentStage
  FROM sync_requests sr
  LEFT JOIN customers c ON c.lineChatId = sr.lineChatId
  WHERE sr.status = 'pending'
`;
const SQL_NO_SUMMARY = `
  SELECT c.lineChatId AS lineChatId, c.lineName AS lineName, c.currentStage AS currentStage
  FROM customers c
  WHERE (c.currentStage IS NULL OR c.currentStage != '流失')
    AND EXISTS (SELECT 1 FROM messages m WHERE m.lineChatId = c.lineChatId)
    AND NOT EXISTS (SELECT 1 FROM summaries s WHERE s.lineChatId = c.lineChatId)
`;

let T: TestDb;
let db: Database.Database;

beforeEach(() => {
  T = createTestDb();
  db = T.db;
});
afterEach(() => closeTestDb(T));

const now = () => Date.now();
function addCustomer(chatId: string, stage = '洽談'): void {
  db.prepare('INSERT INTO customers (lineChatId, currentStage, createdAt) VALUES (?, ?, ?)').run(chatId, stage, now());
}
function addMessage(chatId: string): void {
  db.prepare('INSERT INTO messages (lineChatId, direction, msgType, text, timestamp) VALUES (?, ?, ?, ?, ?)').run(
    chatId,
    'in',
    'text',
    'hi',
    now()
  );
}
function addSummary(chatId: string, orderId = 0): void {
  db.prepare('INSERT INTO summaries (lineChatId, summaryText, orderId, createdAt) VALUES (?, ?, ?, ?)').run(
    chatId,
    '總結內容',
    orderId,
    now()
  );
}
function addSyncRequest(chatId: string, status: 'pending' | 'done' | 'error'): void {
  db.prepare('INSERT INTO sync_requests (lineChatId, status, requestedAt) VALUES (?, ?, ?)').run(chatId, status, now());
}
const pendingBuild = () => (db.prepare(SQL_PENDING_BUILD).all() as { lineChatId: string }[]).map((r) => r.lineChatId).sort();
const noSummary = () => (db.prepare(SQL_NO_SUMMARY).all() as { lineChatId: string }[]).map((r) => r.lineChatId).sort();

test('pending-build:仅 status=pending 提醒;done/error 不提醒', () => {
  addCustomer('CP');
  addSyncRequest('CP', 'pending');
  addCustomer('CD');
  addSyncRequest('CD', 'done');
  addCustomer('CE');
  addSyncRequest('CE', 'error');
  assert.deepEqual(pendingBuild(), ['CP']);
});

test('pending-build:客户档尚未建立(LEFT JOIN)也能提醒', () => {
  // 只有 sync_requests、没有 customers 行:仍应出现在待建档提醒
  addSyncRequest('CNoCustomer', 'pending');
  assert.deepEqual(pendingBuild(), ['CNoCustomer']);
});

test('no-summary:有对话但从未总结、非流失 → 提醒', () => {
  addCustomer('C1');
  addMessage('C1');
  assert.deepEqual(noSummary(), ['C1']);
});

test('no-summary:已总结客户不误报', () => {
  addCustomer('C1');
  addMessage('C1');
  addSummary('C1'); // 整體总结
  assert.deepEqual(noSummary(), []);
});

test('no-summary:仅有订单总结(orderId>0)也算「已总结」,不提醒', () => {
  addCustomer('C1');
  addMessage('C1');
  addSummary('C1', 5); // 订单总结 → NOT EXISTS 仍命中,故不提醒
  assert.deepEqual(noSummary(), []);
});

test('no-summary:流失客户不提醒', () => {
  addCustomer('CLost', '流失');
  addMessage('CLost');
  assert.deepEqual(noSummary(), []);
});

test('no-summary:无对话(无 messages)不提醒', () => {
  addCustomer('CQuiet'); // 建了档但没有任何讯息
  assert.deepEqual(noSummary(), []);
});

test('两类独立且不干扰既有 deadline 判定', () => {
  // 一个有 deadline 的客户,同时也从未总结:no-summary 会抓到它,但既有 deadline 逻辑独立于两新查询。
  addCustomer('CDL');
  addMessage('CDL');
  const soon = now() + 2 * 86_400_000;
  db.prepare('INSERT INTO stage_meta (lineChatId, deadlineAt, updatedAt) VALUES (?, ?, ?)').run('CDL', soon, now());

  // deadline 判定只看 stage_meta.deadlineAt,不受新查询影响
  const dl = db
    .prepare('SELECT deadlineAt FROM stage_meta WHERE lineChatId = ? AND deadlineAt IS NOT NULL')
    .get('CDL') as { deadlineAt: number } | undefined;
  assert.equal(dl?.deadlineAt, soon, 'deadline 数据独立保留');

  // 该客户既无总结 → 也进 no-summary(两类可同时命中同一客户,互不排斥)
  assert.deepEqual(noSummary(), ['CDL']);
  // 但它没有 pending 的 sync_requests → 不在 pending-build
  assert.deepEqual(pendingBuild(), []);
});
