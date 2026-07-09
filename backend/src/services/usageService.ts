/**
 * usageService.ts — LLM 用量追踪。每次呼叫 LLM(总结)后写一笔 llm_usage,
 * 供管理端观察用量/成本/失败率。schema 已建(见 db.ts:llm_usage),此处不碰 db 结构。
 * recordUsage 内部 try/catch,写入失败绝不拖垮总结主流程(与 auditService 同原则)。
 */
import db from '../db.js';

export type UsageTrigger = 'manual' | 'auto-build';

export interface RecordUsageInput {
  lineChatId?: string | null;
  orderId?: number | null;
  model?: string | null;
  durationMs?: number | null;
  ok: boolean;
  error?: string | null;
  trigger?: UsageTrigger | string | null;
}

const insertUsageStmt = db.prepare(`
  INSERT INTO llm_usage (lineChatId, orderId, model, durationMs, ok, error, trigger, createdAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

/** 记一笔 LLM 用量。ok=false 时应带 error;失败不抛(记录不可拖垮主流程)。 */
export function recordUsage(input: RecordUsageInput): void {
  try {
    insertUsageStmt.run(
      typeof input.lineChatId === 'string' ? input.lineChatId : null,
      typeof input.orderId === 'number' && input.orderId > 0 ? Math.trunc(input.orderId) : 0,
      typeof input.model === 'string' ? input.model : null,
      typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
        ? Math.max(0, Math.trunc(input.durationMs))
        : null,
      input.ok ? 1 : 0,
      input.ok ? null : typeof input.error === 'string' ? input.error : input.error != null ? String(input.error) : null,
      typeof input.trigger === 'string' ? input.trigger : null,
      Date.now()
    );
  } catch {
    /* 用量写入失败不影响主流程 */
  }
}

export interface UsageDayRow {
  date: string;
  count: number;
  okCount: number;
  failCount: number;
  avgMs: number;
  totalMs: number;
}

// 按「本地时区」的日期聚合(createdAt 为 epoch ms);avgMs 四舍五入为整数。
const summaryStmt = db.prepare(`
  SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS date,
         COUNT(*)                              AS count,
         SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS okCount,
         SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failCount,
         AVG(durationMs)                       AS avgMs,
         COALESCE(SUM(durationMs), 0)          AS totalMs
  FROM llm_usage
  WHERE createdAt >= ?
  GROUP BY date
  ORDER BY date DESC
`);

/** 近 days 天按天聚合({date, count, okCount, failCount, avgMs, totalMs},date 倒序)。 */
export function summary(days = 30): UsageDayRow[] {
  const d = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);
  const cutoff = Date.now() - d * 86_400_000;
  const rows = summaryStmt.all(cutoff) as {
    date: string;
    count: number;
    okCount: number;
    failCount: number;
    avgMs: number | null;
    totalMs: number;
  }[];
  return rows.map((r) => ({
    date: r.date,
    count: r.count,
    okCount: r.okCount,
    failCount: r.failCount,
    avgMs: r.avgMs == null ? 0 : Math.round(r.avgMs),
    totalMs: r.totalMs,
  }));
}

export interface UsageRow {
  id: number;
  lineChatId: string | null;
  orderId: number;
  model: string | null;
  durationMs: number | null;
  ok: number;
  error: string | null;
  trigger: string | null;
  createdAt: number | null;
}

const recentStmt = db.prepare(`
  SELECT id, lineChatId, orderId, model, durationMs, ok, error, trigger, createdAt
  FROM llm_usage
  ORDER BY createdAt DESC, id DESC
  LIMIT ?
`);

/** 最近 N 笔用量(createdAt 倒序)。 */
export function recent(limit = 50): UsageRow[] {
  const lim = Math.min(Math.max(Math.trunc(limit) || 50, 1), 500);
  return recentStmt.all(lim) as UsageRow[];
}
