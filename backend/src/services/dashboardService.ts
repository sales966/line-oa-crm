/**
 * dashboardService.ts — 总览仪表板 + 到期提醒业务逻辑(routes 不直接碰 db)。
 * - stats():全站计数(客户总数 / 各阶段 / 待处理 / 有总结 / 已完成)。
 * - reminders():逾期或临近的提醒清单(大貨死線、打樣、生產),按急迫度排序。
 * 时间一律 epoch ms 整数;所有计数以 customers.currentStage 等去正规化字段为权威(便宜的 GROUP BY)。
 */
import db from '../db.js';
import { STAGE_ORDER } from '../stageTemplate.js';

const DAY_MS = 86_400_000;

// ── stats ────────────────────────────────────────────────────────────────
export interface DashboardStats {
  totalCustomers: number;
  /** 各阶段客户数;固定含 5 阶段 + 流失(即使为 0),另附任何其他残留 stage 值 */
  byStage: Record<string, number>;
  /** 待处理:LINE 侧 followedUp 标记 */
  followedUpCount: number;
  /** 已产生过 AI 总结的客户数 */
  withSummary: number;
  /** 已完成:LINE 侧 done 标记 */
  buildDone: number;
}

const totalCustomersStmt = db.prepare('SELECT COUNT(*) AS c FROM customers');
const byStageStmt = db.prepare(
  'SELECT currentStage AS stage, COUNT(*) AS c FROM customers GROUP BY currentStage'
);
const followedUpStmt = db.prepare('SELECT COUNT(*) AS c FROM customers WHERE followedUp = 1');
const doneStmt = db.prepare('SELECT COUNT(*) AS c FROM customers WHERE done = 1');
// 有总结的客户 = summaries 中出现过的不同 lineChatId 数(去正规化的 lastSummaryId 不保证维护)
// 仅计整體总结(orderId=0);订单总结不计入此「已总结客户」指标,保持既有仪表板语义不变。
const withSummaryStmt = db.prepare(
  'SELECT COUNT(DISTINCT lineChatId) AS c FROM summaries WHERE orderId = 0'
);

export function stats(): DashboardStats {
  const total = (totalCustomersStmt.get() as { c: number }).c;

  // 预填 5 阶段 + 流失 为 0,再叠加实际计数(其他残留 stage 值也保留)
  const byStage: Record<string, number> = {};
  for (const s of STAGE_ORDER) byStage[s] = 0;
  byStage['流失'] = 0;
  const rows = byStageStmt.all() as { stage: string | null; c: number }[];
  for (const r of rows) {
    const key = typeof r.stage === 'string' && r.stage.trim() ? r.stage.trim() : '洽談';
    byStage[key] = (byStage[key] ?? 0) + r.c;
  }

  return {
    totalCustomers: total,
    byStage,
    followedUpCount: (followedUpStmt.get() as { c: number }).c,
    withSummary: (withSummaryStmt.get() as { c: number }).c,
    buildDone: (doneStmt.get() as { c: number }).c,
  };
}

// ── reminders ──────────────────────────────────────────────────────────────
export type ReminderKind = 'deadline' | 'sample' | 'production';

export interface Reminder {
  lineChatId: string;
  customerName: string | null;
  currentStage: string;
  kind: ReminderKind;
  /** 到期时间(epoch ms) */
  dueAt: number;
  /** 以「当天 00:00」为基准的整数天数差:今天=0、未来>0、逾期<0 */
  daysLeft: number;
  /** 提醒说明(含证据/日期) */
  note: string;
}

interface MetaJoinRow {
  lineChatId: string;
  lineName: string | null;
  currentStage: string | null;
  sampleLeadDays: number | null;
  sampleStartAt: number | null;
  productionLeadDays: number | null;
  productionStartAt: number | null;
  deadlineAt: number | null;
  deadlineEvidence: string | null;
}

// 扫 stage_meta,连带客户名/当前阶段;有死線或有打樣/生產起算日的才需要
const metaJoinStmt = db.prepare(`
  SELECT sm.lineChatId, c.lineName, c.currentStage,
    sm.sampleLeadDays, sm.sampleStartAt,
    sm.productionLeadDays, sm.productionStartAt,
    sm.deadlineAt, sm.deadlineEvidence
  FROM stage_meta sm
  JOIN customers c ON c.lineChatId = sm.lineChatId
  WHERE sm.deadlineAt IS NOT NULL
     OR (sm.sampleStartAt IS NOT NULL AND sm.sampleLeadDays IS NOT NULL)
     OR (sm.productionStartAt IS NOT NULL AND sm.productionLeadDays IS NOT NULL)
`);

// 判定「对应阶段任务是否已完成」用的关键任务完成状态
const doneTasksStmt = db.prepare(
  `SELECT lineChatId, taskKey FROM stage_tasks
   WHERE done = 1 AND taskKey IN ('sample_sent','sample_confirmed','ship_notify','customer_received')`
);

/** 以「当天 00:00」为基准算整数天数差(与 progressService.buildDeadline 一致) */
function daysLeftFrom(at: number): number {
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const startAt = new Date(at);
  startAt.setHours(0, 0, 0, 0);
  return Math.round((startAt.getTime() - startToday.getTime()) / DAY_MS);
}

/** 本地 M/D 显示 */
function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const STAGE_INDEX: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  STAGE_ORDER.forEach((s, i) => (m[s] = i));
  return m;
})();

/**
 * 逾期/临近提醒清单。规则:
 * - deadline:stage_meta.deadlineAt 已过或 7 天内(daysLeft <= 7)。
 * - sample:sampleStartAt + sampleLeadDays 已过,且打樣任务未完成(sample_sent / sample_confirmed 皆未 done)。
 * - production:productionStartAt + productionLeadDays 已过,且生產/出貨任务未完成
 *   (ship_notify 未 done 且当前阶段尚未到「已出廠/已交付」)。
 * 流失客户不提醒。按 daysLeft 升序(最急/逾期最多的在前)。
 */
export function reminders(): Reminder[] {
  const now = Date.now();
  const rows = metaJoinStmt.all() as MetaJoinRow[];

  // 每个 chat 已完成的关键任务集合
  const doneByChat = new Map<string, Set<string>>();
  for (const t of doneTasksStmt.all() as { lineChatId: string; taskKey: string }[]) {
    let set = doneByChat.get(t.lineChatId);
    if (!set) doneByChat.set(t.lineChatId, (set = new Set<string>()));
    set.add(t.taskKey);
  }

  const out: Reminder[] = [];

  for (const r of rows) {
    const stage = typeof r.currentStage === 'string' && r.currentStage.trim() ? r.currentStage.trim() : '洽談';
    if (stage === '流失') continue; // 流失不提醒
    const doneSet = doneByChat.get(r.lineChatId) ?? new Set<string>();
    const stageIdx = STAGE_INDEX[stage] ?? 0;

    // deadline:逾期或 7 天内。已交付(阶段到「已交付」或客户已簽收)则死線失效,不再提醒。
    const delivered = stageIdx >= STAGE_INDEX['已交付'] || doneSet.has('customer_received');
    if (r.deadlineAt != null && Number.isFinite(r.deadlineAt) && !delivered) {
      const daysLeft = daysLeftFrom(r.deadlineAt);
      if (daysLeft <= 7) {
        const ev =
          typeof r.deadlineEvidence === 'string' && r.deadlineEvidence.trim()
            ? r.deadlineEvidence.trim()
            : null;
        const note =
          (daysLeft < 0 ? `大貨交期已逾期 ${-daysLeft} 天` : daysLeft === 0 ? '大貨交期今天到期' : `大貨交期剩 ${daysLeft} 天`) +
          `(${fmtDate(r.deadlineAt)})` +
          (ev ? ` — ${ev}` : '');
        out.push({
          lineChatId: r.lineChatId,
          customerName: r.lineName,
          currentStage: stage,
          kind: 'deadline',
          dueAt: r.deadlineAt,
          daysLeft,
          note,
        });
      }
    }

    // sample:打樣预计完成日已过且样品尚未寄出/确认。阶段已到「已打樣」或之后表示打樣阶段已过,不再提醒。
    if (r.sampleStartAt != null && r.sampleLeadDays != null && stageIdx < STAGE_INDEX['已打樣']) {
      const dueAt = r.sampleStartAt + r.sampleLeadDays * DAY_MS;
      const sampleComplete = doneSet.has('sample_sent') || doneSet.has('sample_confirmed');
      if (dueAt < now && !sampleComplete) {
        const daysLeft = daysLeftFrom(dueAt);
        const overdue = daysLeft < 0 ? `逾期 ${-daysLeft} 天` : '今天到期';
        out.push({
          lineChatId: r.lineChatId,
          customerName: r.lineName,
          currentStage: stage,
          kind: 'sample',
          dueAt,
          daysLeft,
          note: `打樣預計 ${fmtDate(dueAt)} 完成,尚未寄出/確認樣品(${overdue})`,
        });
      }
    }

    // production:生產预计完成日已过且尚未出貨/通知
    if (r.productionStartAt != null && r.productionLeadDays != null) {
      const dueAt = r.productionStartAt + r.productionLeadDays * DAY_MS;
      const shipped = doneSet.has('ship_notify') || stageIdx >= STAGE_INDEX['已出廠'];
      if (dueAt < now && !shipped) {
        const daysLeft = daysLeftFrom(dueAt);
        const overdue = daysLeft < 0 ? `逾期 ${-daysLeft} 天` : '今天到期';
        out.push({
          lineChatId: r.lineChatId,
          customerName: r.lineName,
          currentStage: stage,
          kind: 'production',
          dueAt,
          daysLeft,
          note: `生產預計 ${fmtDate(dueAt)} 完成,尚未出貨(${overdue})`,
        });
      }
    }
  }

  // 按急迫度:daysLeft 升序(逾期最多/最急在前),同值以 dueAt 升序稳定
  out.sort((a, b) => a.daysLeft - b.daysLeft || a.dueAt - b.dueAt);
  return out;
}
