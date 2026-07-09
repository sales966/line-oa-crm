/**
 * summarizeGuard.ts — 每 chatId 的「正在总结」进程内互斥锁。
 * 由 routes/summarize.ts(webui 手动重生)与 routes/ingest.ts(建档 done 自动总结)共用,
 * 避免同一 chat 同时跑两次 LLM 总结、各自 INSERT 一行 summaries(双倍费用 + 两条「最新」总结)。
 * v1 单机单进程,内存 Set 即可。
 */
const inFlight = new Set<string>();

/** 尝试取得某 chat 的总结锁;成功回 true(调用方负责在完成后 release)。 */
export function acquireSummarize(chatId: string): boolean {
  if (inFlight.has(chatId)) return false;
  inFlight.add(chatId);
  return true;
}

/** 释放某 chat 的总结锁。 */
export function releaseSummarize(chatId: string): void {
  inFlight.delete(chatId);
}
