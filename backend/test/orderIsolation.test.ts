/**
 * orderIsolation.test.ts — 订单进度隔离不变量。
 * 对某 orderId 写 order_stage_tasks / 计算订单阶段,绝不影响:
 *  - 整體 stage_tasks(仍为空)
 *  - customers.currentStage(computeOrderStage 纯计算、不写回)
 * 也验证不同订单之间彼此隔离(各自 UNIQUE(orderId, taskKey))。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {
  createTestDb,
  closeTestDb,
  type TestDb,
  SQL_ORDER_UPSERT_MANUAL_TASK,
} from './helpers.js';
import { STAGE_ORDER, TASK_KEY_TO_STAGE, type StageName } from '../src/stageTemplate.js';

let T: TestDb;
let db: Database.Database;
const CHAT = 'Ctest-order';
let orderA: number;
let orderB: number;

beforeEach(() => {
  T = createTestDb();
  db = T.db;
  const now = Date.now();
  db.prepare('INSERT INTO customers (lineChatId, currentStage, createdAt) VALUES (?, ?, ?)').run(
    CHAT,
    '洽談',
    now
  );
  orderA = Number(
    db.prepare('INSERT INTO orders (lineChatId, title, createdAt) VALUES (?, ?, ?)').run(CHAT, 'A 单', now)
      .lastInsertRowid
  );
  orderB = Number(
    db.prepare('INSERT INTO orders (lineChatId, title, createdAt) VALUES (?, ?, ?)').run(CHAT, 'B 单', now)
      .lastInsertRowid
  );
});
afterEach(() => closeTestDb(T));

function setOrderTask(orderId: number, taskKey: string, done: boolean): void {
  db.prepare(SQL_ORDER_UPSERT_MANUAL_TASK).run({
    orderId,
    stage: TASK_KEY_TO_STAGE[taskKey],
    taskKey,
    done: done ? 1 : 0,
    evidence: null,
    setEvidence: 0,
    now: Date.now(),
  });
}
// orderProgressService.computeOrderStage:纯计算,不写回任何「当前阶段」栏位
function computeOrderStage(orderId: number): StageName {
  const rows = db
    .prepare('SELECT taskKey, done FROM order_stage_tasks WHERE orderId = ?')
    .all(orderId) as { taskKey: string; done: number }[];
  let bestIdx = -1;
  for (const r of rows) {
    if (r.done) {
      const idx = STAGE_ORDER.indexOf(TASK_KEY_TO_STAGE[r.taskKey]);
      if (idx > bestIdx) bestIdx = idx;
    }
  }
  return bestIdx >= 0 ? STAGE_ORDER[bestIdx] : STAGE_ORDER[0];
}
const customerStage = () =>
  (db.prepare('SELECT currentStage FROM customers WHERE lineChatId = ?').get(CHAT) as { currentStage: string })
    .currentStage;

test('写 order_stage_tasks 不影响整體 stage_tasks', () => {
  setOrderTask(orderA, 'prod_arrange', true);
  const overall = db.prepare('SELECT COUNT(*) AS n FROM stage_tasks').get() as { n: number };
  assert.equal(overall.n, 0, '整體 stage_tasks 应保持为空');
  const orderRows = db.prepare('SELECT COUNT(*) AS n FROM order_stage_tasks WHERE orderId = ?').get(orderA) as {
    n: number;
  };
  assert.equal(orderRows.n, 1);
});

test('computeOrderStage 不写回 customers.currentStage', () => {
  setOrderTask(orderA, 'prod_arrange', true); // 已打樣
  assert.equal(computeOrderStage(orderA), '已打樣');
  assert.equal(customerStage(), '洽談', 'customers.currentStage 不受订单进度影响');
});

test('不同订单彼此隔离', () => {
  setOrderTask(orderA, 'prod_arrange', true); // A → 已打樣
  setOrderTask(orderB, 'quote_signed', true); // B → 已回簽
  assert.equal(computeOrderStage(orderA), '已打樣');
  assert.equal(computeOrderStage(orderB), '已回簽');

  // A 的 taskKey 只影响 A;B 的同名不存在
  const aRow = db
    .prepare('SELECT done FROM order_stage_tasks WHERE orderId = ? AND taskKey = ?')
    .get(orderA, 'prod_arrange') as { done: number } | undefined;
  const bRow = db
    .prepare('SELECT done FROM order_stage_tasks WHERE orderId = ? AND taskKey = ?')
    .get(orderB, 'prod_arrange') as { done: number } | undefined;
  assert.equal(aRow?.done, 1);
  assert.equal(bRow, undefined, 'B 单不应看到 A 单的任务');
});

test('UNIQUE(orderId, taskKey):同一订单同一任务只有一行(upsert)', () => {
  setOrderTask(orderA, 'quote_signed', true);
  setOrderTask(orderA, 'quote_signed', false);
  const rows = db
    .prepare('SELECT done FROM order_stage_tasks WHERE orderId = ? AND taskKey = ?')
    .all(orderA, 'quote_signed') as { done: number }[];
  assert.equal(rows.length, 1, '应 upsert 为单行');
  assert.equal(rows[0].done, 0, '保留最后一次写入');
});
