/**
 * stageTemplate.test.ts — 阶段模板纯函数(直接 import 真实代码,无 db 依赖)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGE_ORDER,
  STAGE_TASKS,
  TASK_KEY_TO_STAGE,
  TASK_KEY_TO_LABEL,
  isKnownTaskKey,
  isKnownStage,
} from '../src/stageTemplate.js';

test('STAGE_ORDER 是契约 5 阶段的固定顺序(繁体)', () => {
  assert.deepEqual([...STAGE_ORDER], ['洽談', '已回簽', '已打樣', '已出廠', '已交付']);
});

test('TASK_KEY_TO_STAGE 覆盖每个阶段的每个 taskKey', () => {
  for (const stage of STAGE_ORDER) {
    for (const t of STAGE_TASKS[stage]) {
      assert.equal(TASK_KEY_TO_STAGE[t.taskKey], stage, `${t.taskKey} 应属 ${stage}`);
      assert.equal(TASK_KEY_TO_LABEL[t.taskKey], t.label);
    }
  }
});

test('isKnownTaskKey / isKnownStage 判定', () => {
  assert.equal(isKnownTaskKey('quote_signed'), true);
  assert.equal(isKnownTaskKey('nope'), false);
  assert.equal(isKnownTaskKey(123), false);
  assert.equal(isKnownStage('已交付'), true);
  assert.equal(isKnownStage('流失'), false); // 流失是旁支,不入 5 阶段顺序
  assert.equal(isKnownStage('洽谈'), false); // 简体不算已知阶段
});

test('quote_signed 属「已回簽」,case_closed 属「已交付」(阶段边界锚点)', () => {
  assert.equal(TASK_KEY_TO_STAGE['quote_signed'], '已回簽');
  assert.equal(TASK_KEY_TO_STAGE['case_closed'], '已交付');
});
