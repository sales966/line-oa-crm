/**
 * orderProgressService.ts — 订单进度业务逻辑(平行 progressService,但键为 orderId,
 * 读写独立的 order_stage_tasks / order_stage_meta,绝不触碰 stage_tasks / stage_meta)。
 *
 * 与 progressService 的差异:
 * - 主键是 orderId(number),不是 lineChatId。
 * - order_stage_meta 无 signedAt 栏位(schema 由协调者建;为与前端复用,回传形状仍保留 signedAt: null)。
 * - computeOrderStage 只计算并回传,不写回任何「当前阶段」栏位(订单无对应栏位;整體 customers.currentStage 不受影响)。
 * 回传形状(ProgressResult/ProgressTask/ProgressMeta 等)直接复用 progressService 的型别,确保与整體视图一致、前端可复用。
 */
import db from '../db.js';
import { recordAudit, type AuditActor } from './auditService.js';
import {
  STAGE_ORDER,
  STAGE_TASKS,
  TASK_KEY_TO_STAGE,
  TASK_KEY_TO_LABEL,
  isKnownTaskKey,
  isKnownStage,
  type StageName,
} from '../stageTemplate.js';
import type {
  ProgressTask,
  ProgressStage,
  ProgressResult,
  MetaPatch,
  SetTaskResult,
  SetMetaResult,
  LlmTaskStatusItem,
} from './progressService.js';
import { parseLocalDateMs } from './progressService.js';

const DAY_MS = 86_400_000;

// ── order_stage_tasks ─────────────────────────────────────────────────────
interface TaskRow {
  taskKey: string;
  done: number;
  source: string | null;
  evidence: string | null;
}

const tasksByOrderStmt = db.prepare(
  'SELECT taskKey, done, source, evidence FROM order_stage_tasks WHERE orderId = ?'
);
const oneTaskStmt = db.prepare(
  'SELECT taskKey, done, source, evidence FROM order_stage_tasks WHERE orderId = ? AND taskKey = ?'
);

// 手动切换:无条件写入并锁定 source='manual'(与整體 stage_tasks 完全相同的语义)
const upsertManualTaskStmt = db.prepare(`
  INSERT INTO order_stage_tasks (orderId, stage, taskKey, done, source, evidence, updatedAt)
  VALUES (@orderId, @stage, @taskKey, @done, 'manual', @evidence, @now)
  ON CONFLICT(orderId, taskKey) DO UPDATE SET
    done = excluded.done,
    source = 'manual',
    evidence = CASE WHEN @setEvidence = 1 THEN @evidence ELSE order_stage_tasks.evidence END,
    updatedAt = excluded.updatedAt
`);

// LLM 写入:仅在该行不存在或 source!='manual' 时生效(手动优先)
const upsertLlmTaskStmt = db.prepare(`
  INSERT INTO order_stage_tasks (orderId, stage, taskKey, done, source, evidence, updatedAt)
  VALUES (@orderId, @stage, @taskKey, @done, 'llm', @evidence, @now)
  ON CONFLICT(orderId, taskKey) DO UPDATE SET
    done = excluded.done,
    evidence = excluded.evidence,
    updatedAt = excluded.updatedAt
  WHERE order_stage_tasks.source != 'manual'
`);

// ── order_stage_meta ──────────────────────────────────────────────────────
// 注意:order_stage_meta 无 signedAt 栏位(与整體 stage_meta 的差异)。
interface OrderMetaRow {
  orderId: number;
  stageOverride: string | null;
  sampleLeadDays: number | null;
  sampleStartAt: number | null;
  productionLeadDays: number | null;
  productionStartAt: number | null;
  logisticsProvider: string | null;
  logisticsTrackingNo: string | null;
  logisticsNote: string | null;
  deadlineAt: number | null;
  deadlineSource: string | null;
  deadlineEvidence: string | null;
  updatedAt: number | null;
}

const metaStmt = db.prepare('SELECT * FROM order_stage_meta WHERE orderId = ?');
const upsertMetaStmt = db.prepare(`
  INSERT INTO order_stage_meta (
    orderId, stageOverride, sampleLeadDays, sampleStartAt,
    productionLeadDays, productionStartAt, logisticsProvider, logisticsTrackingNo,
    logisticsNote, deadlineAt, deadlineSource, deadlineEvidence, updatedAt
  ) VALUES (
    @orderId, @stageOverride, @sampleLeadDays, @sampleStartAt,
    @productionLeadDays, @productionStartAt, @logisticsProvider, @logisticsTrackingNo,
    @logisticsNote, @deadlineAt, @deadlineSource, @deadlineEvidence, @updatedAt
  )
  ON CONFLICT(orderId) DO UPDATE SET
    stageOverride = excluded.stageOverride,
    sampleLeadDays = excluded.sampleLeadDays,
    sampleStartAt = excluded.sampleStartAt,
    productionLeadDays = excluded.productionLeadDays,
    productionStartAt = excluded.productionStartAt,
    logisticsProvider = excluded.logisticsProvider,
    logisticsTrackingNo = excluded.logisticsTrackingNo,
    logisticsNote = excluded.logisticsNote,
    deadlineAt = excluded.deadlineAt,
    deadlineSource = excluded.deadlineSource,
    deadlineEvidence = excluded.deadlineEvidence,
    updatedAt = excluded.updatedAt
`);

// 审计需要 lineChatId(audit_log 以 lineChatId 归属);由 orderId 反查所属订单的 chatId。
const orderChatIdStmt = db.prepare('SELECT lineChatId FROM orders WHERE id = ?');
function chatIdOfOrder(orderId: number): string | null {
  const row = orderChatIdStmt.get(orderId) as { lineChatId: string } | undefined;
  return row?.lineChatId ?? null;
}

function getMetaRow(orderId: number): OrderMetaRow | undefined {
  return metaStmt.get(orderId) as OrderMetaRow | undefined;
}

/** stageOverride 有值取非空 trim 后的值,否则 null */
function effectiveOverride(meta: OrderMetaRow | undefined): StageName | null {
  const s = meta?.stageOverride;
  if (typeof s === 'string' && s.trim() && isKnownStage(s.trim())) return s.trim() as StageName;
  return null;
}

/**
 * 计算订单当前阶段。
 * stageOverride 有值 → 用它;否则 = 有任一 done 任务的最靠后阶段(全空=洽談)。
 * 与整體不同:订单没有「当前阶段」持久栏位,故此处纯计算、不写回。
 */
export function computeOrderStage(orderId: number): StageName {
  const meta = getMetaRow(orderId);
  const override = effectiveOverride(meta);
  if (override) return override;
  const rows = tasksByOrderStmt.all(orderId) as TaskRow[];
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
  return bestIdx >= 0 ? STAGE_ORDER[bestIdx] : STAGE_ORDER[0];
}

// ── getOrderProgress ──────────────────────────────────────────────────────
// 大貨死線倒数:以「当天 00:00」为基准算整数天数差,今天=0、未来>0、逾期<0
function buildDeadline(
  at: number | null,
  source: string | null,
  evidence: string | null
): { at: number | null; source: string | null; evidence: string | null; daysLeft: number | null } {
  let daysLeft: number | null = null;
  if (typeof at === 'number' && Number.isFinite(at)) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfDeadline = new Date(at);
    startOfDeadline.setHours(0, 0, 0, 0);
    daysLeft = Math.round((startOfDeadline.getTime() - startOfToday.getTime()) / DAY_MS);
  }
  return { at: at ?? null, source: source ?? null, evidence: evidence ?? null, daysLeft };
}

/** 与 progressService.getProgress 完全一致的回传形状(meta.signedAt 恒为 null:订单表无此栏位)。 */
export function getOrderProgress(orderId: number): ProgressResult {
  const meta = getMetaRow(orderId);
  const taskRows = tasksByOrderStmt.all(orderId) as TaskRow[];
  const byKey = new Map<string, TaskRow>();
  for (const r of taskRows) byKey.set(r.taskKey, r);

  const stages: ProgressStage[] = STAGE_ORDER.map((stage) => ({
    stage,
    tasks: STAGE_TASKS[stage].map((def): ProgressTask => {
      const row = byKey.get(def.taskKey);
      return {
        taskKey: def.taskKey,
        label: def.label,
        done: !!(row && row.done),
        source: row?.source ?? 'llm',
        evidence: row?.evidence ?? null,
      };
    }),
  }));

  const currentStage = computeOrderStage(orderId);

  const sampleDueAt =
    meta && meta.sampleStartAt != null && meta.sampleLeadDays != null
      ? meta.sampleStartAt + meta.sampleLeadDays * DAY_MS
      : null;
  const productionDueAt =
    meta && meta.productionStartAt != null && meta.productionLeadDays != null
      ? meta.productionStartAt + meta.productionLeadDays * DAY_MS
      : null;

  return {
    currentStage,
    stageOverride: meta?.stageOverride ?? null,
    meta: {
      signedAt: null, // 订单表无 signedAt 栏位;保留键以维持与整體一致的形状
      sampleLeadDays: meta?.sampleLeadDays ?? null,
      sampleStartAt: meta?.sampleStartAt ?? null,
      productionLeadDays: meta?.productionLeadDays ?? null,
      productionStartAt: meta?.productionStartAt ?? null,
      logisticsProvider: meta?.logisticsProvider ?? null,
      logisticsTrackingNo: meta?.logisticsTrackingNo ?? null,
      logisticsNote: meta?.logisticsNote ?? null,
      deadlineAt: meta?.deadlineAt ?? null,
      deadlineSource: meta?.deadlineSource ?? null,
      deadlineEvidence: meta?.deadlineEvidence ?? null,
    },
    stages,
    expected: { sampleDueAt, productionDueAt },
    deadline: buildDeadline(meta?.deadlineAt ?? null, meta?.deadlineSource ?? null, meta?.deadlineEvidence ?? null),
  };
}

// ── setOrderTask(手动点灯)─────────────────────────────────────────────────
export function setOrderTask(
  chatId: string,
  orderId: number,
  taskKey: string,
  done: boolean,
  actor: AuditActor,
  evidence?: string | null
): SetTaskResult {
  if (!isKnownTaskKey(taskKey)) return { ok: false, status: 400, error: '未知的 taskKey' };
  const stage = TASK_KEY_TO_STAGE[taskKey];
  const before = oneTaskStmt.get(orderId, taskKey) as TaskRow | undefined;
  const now = Date.now();
  const setEvidence = evidence !== undefined ? 1 : 0;
  const evValue =
    evidence === undefined ? null : typeof evidence === 'string' && evidence.trim() ? evidence.trim() : null;
  upsertManualTaskStmt.run({ orderId, stage, taskKey, done: done ? 1 : 0, evidence: evValue, setEvidence, now });

  recordAudit(chatId, actor, 'order_stage_task_toggle', taskKey, {
    orderId,
    taskKey,
    stage,
    from: before ? !!before.done : null,
    to: done,
    evidenceEdited: setEvidence === 1,
  });

  const saved = oneTaskStmt.get(orderId, taskKey) as TaskRow | undefined;
  return {
    ok: true,
    task: {
      taskKey,
      label: TASK_KEY_TO_LABEL[taskKey],
      done,
      source: 'manual',
      evidence: saved?.evidence ?? null,
    },
  };
}

// ── setOrderMeta(阶段参数 / 手动阶段覆盖)──────────────────────────────────
/** 数字栏位:number/数字字符串→整数;'' 或 null→清空(null);其余保留旧值 */
function coerceIntPatch(patch: MetaPatch, key: keyof MetaPatch, prev: number | null): number | null {
  if (!(key in patch)) return prev;
  const v = patch[key];
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : prev;
}

/** 文本栏位:string→trim(空→null);null→null;未提供→保留旧值 */
function coerceTextPatch(patch: MetaPatch, key: keyof MetaPatch, prev: string | null): string | null {
  if (!(key in patch)) return prev;
  const v = patch[key];
  if (v === null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  return prev;
}

export function setOrderMeta(
  chatId: string,
  orderId: number,
  patch: MetaPatch,
  actor: AuditActor
): SetMetaResult {
  if (!patch || typeof patch !== 'object') {
    return { ok: false, status: 400, error: '缺少更新内容' };
  }
  const prev = getMetaRow(orderId);

  // stageOverride 校验:提供且非空时必须是 5 阶段之一;''/null 清除覆盖
  let stageOverride: string | null = prev?.stageOverride ?? null;
  const overrideChanged = 'stageOverride' in patch;
  if (overrideChanged) {
    const raw = patch.stageOverride;
    if (raw === null || raw === '') {
      stageOverride = null;
    } else if (typeof raw === 'string' && isKnownStage(raw.trim())) {
      stageOverride = raw.trim();
    } else {
      return { ok: false, status: 400, error: 'stageOverride 必须是有效阶段或空' };
    }
  }

  const now = Date.now();
  // 大貨死線:patch 带 deadlineAt → 人工设定(source='manual');清除则一并清 source/evidence
  const deadlineChanged = 'deadlineAt' in patch;
  const newDeadlineAt = deadlineChanged
    ? coerceIntPatch(patch, 'deadlineAt', prev?.deadlineAt ?? null)
    : (prev?.deadlineAt ?? null);
  const newDeadlineSource = deadlineChanged
    ? (newDeadlineAt === null ? null : 'manual')
    : (prev?.deadlineSource ?? null);
  const newDeadlineEvidence = deadlineChanged
    ? (newDeadlineAt === null ? null : '人工設定')
    : (prev?.deadlineEvidence ?? null);
  const merged = {
    orderId,
    stageOverride,
    sampleLeadDays: coerceIntPatch(patch, 'sampleLeadDays', prev?.sampleLeadDays ?? null),
    sampleStartAt: coerceIntPatch(patch, 'sampleStartAt', prev?.sampleStartAt ?? null),
    productionLeadDays: coerceIntPatch(patch, 'productionLeadDays', prev?.productionLeadDays ?? null),
    productionStartAt: coerceIntPatch(patch, 'productionStartAt', prev?.productionStartAt ?? null),
    logisticsProvider: coerceTextPatch(patch, 'logisticsProvider', prev?.logisticsProvider ?? null),
    logisticsTrackingNo: coerceTextPatch(patch, 'logisticsTrackingNo', prev?.logisticsTrackingNo ?? null),
    logisticsNote: coerceTextPatch(patch, 'logisticsNote', prev?.logisticsNote ?? null),
    deadlineAt: newDeadlineAt,
    deadlineSource: newDeadlineSource,
    deadlineEvidence: newDeadlineEvidence,
    updatedAt: now,
  };
  upsertMetaStmt.run(merged);

  recordAudit(chatId, actor, 'order_stage_meta_edit', String(orderId), {
    orderId,
    before: prev
      ? {
          stageOverride: prev.stageOverride,
          sampleLeadDays: prev.sampleLeadDays,
          sampleStartAt: prev.sampleStartAt,
          productionLeadDays: prev.productionLeadDays,
          productionStartAt: prev.productionStartAt,
          logisticsProvider: prev.logisticsProvider,
          logisticsTrackingNo: prev.logisticsTrackingNo,
          logisticsNote: prev.logisticsNote,
        }
      : null,
    after: {
      stageOverride: merged.stageOverride,
      sampleLeadDays: merged.sampleLeadDays,
      sampleStartAt: merged.sampleStartAt,
      productionLeadDays: merged.productionLeadDays,
      productionStartAt: merged.productionStartAt,
      logisticsProvider: merged.logisticsProvider,
      logisticsTrackingNo: merged.logisticsTrackingNo,
      logisticsNote: merged.logisticsNote,
    },
  });

  if (overrideChanged && (prev?.stageOverride ?? null) !== stageOverride) {
    recordAudit(chatId, actor, 'order_stage_override', stageOverride, {
      orderId,
      from: prev?.stageOverride ?? null,
      to: stageOverride,
    });
  }

  return { ok: true, progress: getOrderProgress(orderId) };
}

// ── LLM 定位:写 taskStatus(仅 source!='manual' 行)───────────────────────
/**
 * 订单总结阶段用:把 LLM 判定的 taskStatus 写入 order_stage_tasks,手动行不覆盖。
 * 不在此重算阶段;由调用方(summaryService)写完后调 computeOrderStage。
 */
export function applyLlmTaskStatusForOrder(orderId: number, items: LlmTaskStatusItem[]): void {
  if (!Array.isArray(items) || items.length === 0) return;
  const now = Date.now();
  const write = db.transaction((rows: LlmTaskStatusItem[]) => {
    for (const it of rows) {
      if (!isKnownTaskKey(it.taskKey)) continue;
      const stage = TASK_KEY_TO_STAGE[it.taskKey];
      const evidence =
        typeof it.evidence === 'string' && it.evidence.trim() ? it.evidence.trim() : null;
      upsertLlmTaskStmt.run({
        orderId,
        stage,
        taskKey: it.taskKey,
        done: it.done ? 1 : 0,
        evidence,
        now,
      });
    }
  });
  write(items);
}

/**
 * 订单总结阶段用:把 LLM 侦测到的大貨死線写入 order_stage_meta。
 * 人工设定过的死線(deadlineSource='manual')不覆盖;其余以 LLM 值更新。
 */
export function applyLlmDeadlineForOrder(orderId: number, dateStr: string | null, evidence: string | null): void {
  if (!dateStr || typeof dateStr !== 'string') return;
  const t = parseLocalDateMs(dateStr);
  if (t === null) return;
  const prev = getMetaRow(orderId);
  if (prev?.deadlineSource === 'manual') return; // 人工优先,不覆盖
  const now = Date.now();
  const merged = {
    orderId,
    stageOverride: prev?.stageOverride ?? null,
    sampleLeadDays: prev?.sampleLeadDays ?? null,
    sampleStartAt: prev?.sampleStartAt ?? null,
    productionLeadDays: prev?.productionLeadDays ?? null,
    productionStartAt: prev?.productionStartAt ?? null,
    logisticsProvider: prev?.logisticsProvider ?? null,
    logisticsTrackingNo: prev?.logisticsTrackingNo ?? null,
    logisticsNote: prev?.logisticsNote ?? null,
    deadlineAt: t,
    deadlineSource: 'llm',
    deadlineEvidence: typeof evidence === 'string' && evidence.trim() ? evidence.trim() : null,
    updatedAt: now,
  };
  upsertMetaStmt.run(merged);
}

// 供其他模块(如审计)反查订单所属 chatId
export { chatIdOfOrder };
