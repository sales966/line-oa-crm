/**
 * normalize.test.ts — llm/index.ts 归一化纯函数(无 db 依赖,直接 import 真实代码)。
 * 覆盖:docRole 简→繁归一化、stage 别名归一化、normalizeSummaryOutput 容错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDocRole,
  normalizeStage,
  normalizeSummaryOutput,
} from '../src/llm/index.js';

test('normalizeDocRole:繁体字面值原样通过', () => {
  for (const r of ['報價單', '回簽單', '設計圖', '刀模', '其他']) {
    assert.equal(normalizeDocRole(r), r);
  }
});

test('normalizeDocRole:简体/别名归一化为繁体', () => {
  assert.equal(normalizeDocRole('报价单'), '報價單');
  assert.equal(normalizeDocRole('回签单'), '回簽單');
  assert.equal(normalizeDocRole('设计图'), '設計圖');
  assert.equal(normalizeDocRole('设计稿'), '設計圖');
  assert.equal(normalizeDocRole('設計稿'), '設計圖');
  assert.equal(normalizeDocRole('刀模图'), '刀模');
  assert.equal(normalizeDocRole('刀模圖'), '刀模');
});

test('normalizeDocRole:前后空白容忍、无法识别返回 null', () => {
  assert.equal(normalizeDocRole('  报价单  '), '報價單');
  assert.equal(normalizeDocRole('随便'), null);
  assert.equal(normalizeDocRole(''), null);
  assert.equal(normalizeDocRole(null), null);
  assert.equal(normalizeDocRole(undefined), null);
});

test('normalizeStage:别名与简体归一化,未知回退洽談', () => {
  assert.equal(normalizeStage('洽谈'), '洽談');
  assert.equal(normalizeStage('已报价'), '洽談');
  assert.equal(normalizeStage('已回签'), '已回簽');
  assert.equal(normalizeStage('已生产'), '已打樣');
  assert.equal(normalizeStage('已成交'), '已交付');
  assert.equal(normalizeStage('流失'), '流失'); // 流失是合法枚举
  assert.equal(normalizeStage('乱写'), '洽談'); // 未知回退
});

test('normalizeSummaryOutput:垃圾输入产出安全默认形状', () => {
  const out = normalizeSummaryOutput(null);
  assert.equal(out.summaryText, '');
  assert.equal(out.stageGuess, '洽談');
  assert.deepEqual(out.nextActions, []);
  assert.deepEqual(out.taskStatus, []);
  assert.deepEqual(out.fileRoles, []);
  assert.equal(out.deadline, undefined);
});

test('normalizeSummaryOutput:taskStatus done 多形态、fileRoles 过滤非法项', () => {
  const out = normalizeSummaryOutput({
    summaryText: '  测试  ',
    stageGuess: '已回签',
    taskStatus: [
      { taskKey: 'quote_sent', done: 'true', evidence: '  已寄  ' },
      { taskKey: 'quote_signed', done: 1 },
      { taskKey: '', done: true }, // 无 taskKey → 丢弃
      'garbage',
    ],
    fileRoles: [
      { lineMessageId: 'm1', docRole: '报价单' }, // 归一化为繁体
      { lineMessageId: '', docRole: '報價單' }, // 无 id → 丢弃
      { lineMessageId: 'm2', docRole: '不认识' }, // 非法角色 → 丢弃
    ],
  });
  assert.equal(out.summaryText, '测试');
  assert.equal(out.stageGuess, '已回簽');
  assert.deepEqual(
    out.taskStatus.map((t) => [t.taskKey, t.done, t.evidence]),
    [
      ['quote_sent', true, '已寄'],
      ['quote_signed', true, undefined],
    ]
  );
  assert.equal(out.fileRoles.length, 1);
  assert.deepEqual(out.fileRoles[0], { lineMessageId: 'm1', docRole: '報價單', evidence: undefined });
});
