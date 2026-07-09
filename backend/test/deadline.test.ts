/**
 * deadline.test.ts — 大貨死線 daysLeft 计算(复制自 progressService.buildDeadline)。
 * 不变量:以「当天 00:00」为基准的整数天数差,今天=0、未来>0、逾期<0、未设=null。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysLeftFrom } from './helpers.js';

const DAY_MS = 86_400_000;
/** 今天 00:00 的 epoch ms(与算法同基准) */
function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

test('今天(同一天任意时刻)= 0', () => {
  assert.equal(daysLeftFrom(startOfTodayMs()), 0);
  assert.equal(daysLeftFrom(startOfTodayMs() + 13 * 3600_000), 0, '今天下午仍算今天');
  assert.equal(daysLeftFrom(startOfTodayMs() + DAY_MS - 1), 0, '今天 23:59:59 仍=0');
});

test('未来 > 0', () => {
  assert.equal(daysLeftFrom(startOfTodayMs() + DAY_MS), 1, '明天=1');
  assert.equal(daysLeftFrom(startOfTodayMs() + 7 * DAY_MS), 7);
  assert.equal(daysLeftFrom(startOfTodayMs() + 30 * DAY_MS + 5 * 3600_000), 30, '跨日看日界不看时分');
});

test('逾期 < 0', () => {
  assert.equal(daysLeftFrom(startOfTodayMs() - DAY_MS), -1, '昨天=-1');
  assert.equal(daysLeftFrom(startOfTodayMs() - 3 * DAY_MS), -3);
});

test('未设死線 = null', () => {
  assert.equal(daysLeftFrom(null), null);
  assert.equal(daysLeftFrom(Number.NaN), null);
  assert.equal(daysLeftFrom(Infinity), null);
});
