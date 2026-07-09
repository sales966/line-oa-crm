/**
 * summarizeGuard.test.ts — 同 chat 总结互斥锁(无 db 依赖,直接 import 真实代码)。
 * 不变量:同一 chatId 已在总结时,第二次 acquire 必须失败(避免并发跑两次 LLM / 双倍费用)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireSummarize, releaseSummarize } from '../src/services/summarizeGuard.js';

test('同 chat 不能并发取得两次总结锁', () => {
  const chat = 'Ctest-guard-1';
  assert.equal(acquireSummarize(chat), true, '首次应取得');
  assert.equal(acquireSummarize(chat), false, '未释放前第二次应失败');
  releaseSummarize(chat);
  assert.equal(acquireSummarize(chat), true, '释放后可再次取得');
  releaseSummarize(chat);
});

test('不同 chat 的锁互不影响', () => {
  const a = 'Ctest-guard-a';
  const b = 'Ctest-guard-b';
  assert.equal(acquireSummarize(a), true);
  assert.equal(acquireSummarize(b), true, '不同 chat 应可各自取得');
  assert.equal(acquireSummarize(a), false);
  assert.equal(acquireSummarize(b), false);
  releaseSummarize(a);
  releaseSummarize(b);
});

test('重复 release 幂等,不抛错', () => {
  const chat = 'Ctest-guard-idem';
  assert.equal(acquireSummarize(chat), true);
  releaseSummarize(chat);
  assert.doesNotThrow(() => releaseSummarize(chat));
  assert.equal(acquireSummarize(chat), true);
  releaseSummarize(chat);
});
