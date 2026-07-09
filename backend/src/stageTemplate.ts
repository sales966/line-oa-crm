/**
 * stageTemplate.ts — 进度表阶段与任务模板(写死可改,CONTRACT「进度表」为准)。
 * 5 阶段固定顺序:洽談 → 已回簽 → 已打樣 → 已出廠 → 已交付(流失为旁支状态,不入顺序)。
 * 每阶段一组任务(taskKey→繁体中文 label);进度表红绿灯与 LLM 定位都以此为准。
 */

/** 5 阶段固定顺序(currentStage 计算按此索引取最靠后) */
export const STAGE_ORDER = ['洽談', '已回簽', '已打樣', '已出廠', '已交付'] as const;
export type StageName = (typeof STAGE_ORDER)[number];

export interface StageTaskDef {
  taskKey: string;
  label: string;
}

/** 每阶段任务清单(顺序即展示顺序) */
export const STAGE_TASKS: Record<StageName, StageTaskDef[]> = {
  洽談: [
    { taskKey: 'understand_need', label: '了解需求(盒型/尺寸/數量)' },
    { taskKey: 'contact_info', label: '取得聯絡資訊' },
    { taskKey: 'budget', label: '了解預算' },
    { taskKey: 'quote_sent', label: '出報價單' },
  ],
  已回簽: [
    { taskKey: 'quote_signed', label: '報價單已回簽' },
    { taskKey: 'sample_deposit', label: '收打樣訂金' },
    { taskKey: 'sample_arrange', label: '安排打樣' },
    { taskKey: 'sample_sent', label: '寄出樣品' },
    { taskKey: 'sample_confirmed', label: '客戶確認樣品' },
  ],
  已打樣: [
    { taskKey: 'prod_deposit', label: '收生產訂金/確認下單' },
    { taskKey: 'prod_arrange', label: '安排大貨製作' },
    { taskKey: 'prod_leadtime', label: '確認交期' },
  ],
  已出廠: [
    { taskKey: 'logistics_arrange', label: '安排物流' },
    { taskKey: 'logistics_intl', label: '國際物流資料(物流商/單號/報關)' },
    { taskKey: 'ship_notify', label: '通知客戶出貨' },
  ],
  已交付: [
    { taskKey: 'customer_received', label: '客戶簽收' },
    { taskKey: 'balance_paid', label: '尾款結清' },
    { taskKey: 'case_closed', label: '結案' },
  ],
};

/** taskKey → 所属阶段(反查表) */
export const TASK_KEY_TO_STAGE: Record<string, StageName> = (() => {
  const map: Record<string, StageName> = {};
  for (const stage of STAGE_ORDER) {
    for (const t of STAGE_TASKS[stage]) map[t.taskKey] = stage;
  }
  return map;
})();

/** taskKey → label(反查表) */
export const TASK_KEY_TO_LABEL: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const stage of STAGE_ORDER) {
    for (const t of STAGE_TASKS[stage]) map[t.taskKey] = t.label;
  }
  return map;
})();

/** 是否为已知 taskKey */
export function isKnownTaskKey(taskKey: unknown): taskKey is string {
  return typeof taskKey === 'string' && taskKey in TASK_KEY_TO_STAGE;
}

/** 是否为 5 阶段之一(流失不算) */
export function isKnownStage(stage: unknown): stage is StageName {
  return typeof stage === 'string' && (STAGE_ORDER as readonly string[]).includes(stage);
}
