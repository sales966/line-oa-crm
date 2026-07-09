/**
 * progress.test.ts — 进度表关键不变量(临时库 + 逐字复制的 service SQL + 真实 stageTemplate)。
 * 覆盖:
 *  - 手动点灯(source=manual)后,LLM applyLlmTaskStatus 不覆盖 manual 行(done 与 evidence 都保留)。
 *  - computeCurrentStage 取「有任一 done 任务」的最靠后阶段;全空=洽談。
 *  - 人工补的 evidence 在后续 LLM 写入后仍保留。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {
  createTestDb,
  closeTestDb,
  type TestDb,
  SQL_UPSERT_MANUAL_TASK,
  SQL_UPSERT_LLM_TASK,
  SQL_UPDATE_CUSTOMER_STAGE,
} from './helpers.js';
import {
  STAGE_ORDER,
  TASK_KEY_TO_STAGE,
  type StageName,
} from '../src/stageTemplate.js';

let T: TestDb;
let db: Database.Database;
const CHAT = 'Ctest-progress';

beforeEach(() => {
  T = createTestDb();
  db = T.db;
  db.prepare('INSERT INTO customers (lineChatId, currentStage, createdAt) VALUES (?, ?, ?)').run(
    CHAT,
    '洽談',
    Date.now()
  );
});
afterEach(() => closeTestDb(T));

// ── 复制自 progressService 的写入/计算路径(SQL 与常量均来自真实来源) ──────────
function setManualTask(taskKey: string, done: boolean, evidence?: string | null): void {
  const setEvidence = evidence !== undefined ? 1 : 0;
  const evValue =
    evidence === undefined ? null : typeof evidence === 'string' && evidence.trim() ? evidence.trim() : null;
  db.prepare(SQL_UPSERT_MANUAL_TASK).run({
    chatId: CHAT,
    stage: TASK_KEY_TO_STAGE[taskKey],
    taskKey,
    done: done ? 1 : 0,
    evidence: evValue,
    setEvidence,
    now: Date.now(),
  });
}
function applyLlmTask(taskKey: string, done: boolean, evidence: string | null): void {
  db.prepare(SQL_UPSERT_LLM_TASK).run({
    chatId: CHAT,
    stage: TASK_KEY_TO_STAGE[taskKey],
    taskKey,
    done: done ? 1 : 0,
    evidence,
    now: Date.now(),
  });
}
function getTask(taskKey: string) {
  return db
    .prepare('SELECT taskKey, done, source, evidence FROM stage_tasks WHERE lineChatId = ? AND taskKey = ?')
    .get(CHAT, taskKey) as { done: number; source: string; evidence: string | null } | undefined;
}
function computeCurrentStage(): StageName {
  const rows = db
    .prepare('SELECT taskKey, done FROM stage_tasks WHERE lineChatId = ?')
    .all(CHAT) as { taskKey: string; done: number }[];
  let bestIdx = -1;
  for (const r of rows) {
    if (r.done) {
      const st = TASK_KEY_TO_STAGE[r.taskKey];
      if (st) {
        const idx = STAGE_ORDER.indexOf(st);
        if (idx > bestIdx) bestIdx = idx;
      }
    }
  }
  const stage = bestIdx >= 0 ? STAGE_ORDER[bestIdx] : STAGE_ORDER[0];
  db.prepare(SQL_UPDATE_CUSTOMER_STAGE).run(stage, Date.now(), CHAT, stage);
  return stage;
}
const customerStage = () =>
  (db.prepare('SELECT currentStage FROM customers WHERE lineChatId = ?').get(CHAT) as { currentStage: string })
    .currentStage;

// ── 测试 ─────────────────────────────────────────────────────────────────────

test('LLM 不覆盖 manual 行:done 保持人工值', () => {
  // 人工把 quote_signed 点亮(done=true)
  setManualTask('quote_signed', true);
  assert.equal(getTask('quote_signed')?.source, 'manual');
  assert.equal(getTask('quote_signed')?.done, 1);

  // LLM 试图把它改回 未完成(done=false)——应被 WHERE source != 'manual' 拦截
  applyLlmTask('quote_signed', false, 'LLM 认为未回簽');
  const row = getTask('quote_signed');
  assert.equal(row?.source, 'manual', 'source 仍为 manual');
  assert.equal(row?.done, 1, 'manual 的 done 未被 LLM 覆盖');
});

test('人工补的 evidence 在后续 LLM 写入后仍保留', () => {
  setManualTask('quote_signed', true, '客户 6/1 已回签报价单');
  assert.equal(getTask('quote_signed')?.evidence, '客户 6/1 已回签报价单');

  applyLlmTask('quote_signed', true, 'LLM 另写的证据');
  assert.equal(
    getTask('quote_signed')?.evidence,
    '客户 6/1 已回签报价单',
    '人工 evidence 不被 LLM 覆盖'
  );
});

test('LLM 可写入非 manual 的空行(首次定位)', () => {
  applyLlmTask('quote_sent', true, '已寄出报价单');
  const row = getTask('quote_sent');
  assert.equal(row?.source, 'llm');
  assert.equal(row?.done, 1);
  assert.equal(row?.evidence, '已寄出报价单');
});

test('computeCurrentStage 取最靠后的 done 阶段', () => {
  assert.equal(computeCurrentStage(), '洽談', '无 done 任务时=洽談');

  applyLlmTask('quote_sent', true, null); // 洽談
  assert.equal(computeCurrentStage(), '洽談');

  applyLlmTask('prod_arrange', true, null); // 已打樣(更靠后)
  applyLlmTask('quote_signed', true, null); // 已回簽(较靠前)
  assert.equal(computeCurrentStage(), '已打樣', '取最靠后的 done 阶段');
  assert.equal(customerStage(), '已打樣', '写回 customers.currentStage');
});

test('done=0 的任务不参与阶段计算', () => {
  applyLlmTask('quote_sent', true, null); // 洽談 done
  applyLlmTask('prod_arrange', false, null); // 已打樣 但 done=0
  assert.equal(computeCurrentStage(), '洽談', 'done=0 不算最靠后阶段');
});

test('manual 关灯同样锁定:LLM 不能把 manual 的 false 改回 true', () => {
  applyLlmTask('quote_signed', true, null); // 先由 LLM 点亮
  setManualTask('quote_signed', false); // 人工关灯并锁定
  assert.equal(getTask('quote_signed')?.done, 0);
  applyLlmTask('quote_signed', true, null); // LLM 想重新点亮
  assert.equal(getTask('quote_signed')?.done, 0, 'manual 关灯不被 LLM 覆盖');
  assert.equal(getTask('quote_signed')?.source, 'manual');
});
