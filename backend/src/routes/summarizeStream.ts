/**
 * routes/summarizeStream.ts — LLM 总结的「SSE 串流」通道(可选加速版)。
 *
 * 与 routes/summarize.ts 完全平行:相同守卫(冷却 + acquireSummarize 互斥锁 +
 * orderId/key 逻辑 + actor),同一把 summarizeGuard(整體 key=chatId、订单 key=chatId#orderId)
 * 与非串流路由「同键互斥」——两条路径绝不会并发同一 key(避免双倍 LLM 费用 / 两行「最新」总结)。
 *
 * 差异只在传输:走 reply.raw 写 text/event-stream,把 provider 的渐进 summaryText
 * 以 SSE event 'delta' 推给前端即时显示;完成写 event 'done';任何错误写 event 'error'。
 * 底层解析 / 持久化 / 灯号 / 死线 / 档案角色仍由 summarizeChat 一字不动地完成。
 * 既有 POST /api/summarize/:chatId(非串流)完全保留,作为随时可退回的路径。
 *
 * 注:本路由自持一份冷却 Map(不改动非串流路由)。跨路径的「money-critical」互斥
 * 由共用的 acquireSummarize(key) 保证;冷却仅为各自的防抖,不影响并发安全。
 */
import type { FastifyInstance } from 'fastify';
import { summarizeChat } from '../services/summaryService.js';
import { acquireSummarize, releaseSummarize } from '../services/summarizeGuard.js';
import { SUMMARIZE_COOLDOWN_MS } from '../config.js';

/** chatId(或 chatId#orderId)→ 最近一次开始生成的时间(ms);本路由自持,进程内即可 */
const lastSummarizeAt = new Map<string, number>();

export default async function summarizeStreamRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/summarize/:chatId/stream?force=1&orderId=N
  // 守卫与 /api/summarize/:chatId 一致;仅回应改为 SSE。
  app.post('/api/summarize/:chatId/stream', async (req, reply) => {
    const { chatId: rawChatId } = req.params as { chatId: string };
    const q = (req.query ?? {}) as { force?: string; orderId?: string };
    const force = q.force === '1' || q.force === 'true';
    const oid = Number(q.orderId);
    const orderId = Number.isFinite(oid) && Math.trunc(oid) > 0 ? Math.trunc(oid) : 0;

    // 接管底层回应,改用 SSE 直写(Fastify 不再自行送出回应)
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 反向代理(nginx 等)下关闭缓冲,确保 delta 即时抵达
      'X-Accel-Buffering': 'no',
    });

    // ended:标记 SSE 已结束(或 socket 已断),之后不再 write / end
    let ended = false;
    const sse = (event: string, data: unknown): void => {
      if (ended) return;
      try {
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* socket 可能已断,忽略 */
      }
    };
    const endStream = (): void => {
      if (ended) return;
      ended = true;
      try {
        raw.end();
      } catch {
        /* 已结束,忽略 */
      }
    };

    // 缺 chatId:直接以 SSE error 结束
    if (!rawChatId || !rawChatId.trim()) {
      sse('error', { error: '缺少 chatId', status: 400 });
      return endStream();
    }
    const chatId = rawChatId.trim();
    // 冷却/锁的键:整體=chatId;订单=chatId#orderId(与非串流路由同键)
    const key = orderId > 0 ? `${chatId}#${orderId}` : chatId;

    // 冷却:冷却期内的重复请求以 409 结束(不占用锁)
    const now = Date.now();
    const last = lastSummarizeAt.get(key);
    if (last !== undefined && now - last < SUMMARIZE_COOLDOWN_MS) {
      const waitSec = Math.ceil((SUMMARIZE_COOLDOWN_MS - (now - last)) / 1000);
      sse('error', { error: `總結生成過於頻繁,請 ${waitSec} 秒後再試`, status: 409 });
      return endStream();
    }
    // 跨路径互斥:与非串流路由 / 建档自动总结共用 summarizeGuard,拒绝同一 key 并发
    if (!acquireSummarize(key)) {
      sse('error', { error: '該客戶正在生成總結,請稍候再試', status: 409 });
      return endStream();
    }
    // 先占位:挡住冷却期内的并发重复请求
    lastSummarizeAt.set(key, now);

    // 锁只释放一次;客户端中断(raw 'close')与正常结束(finally)都经此
    let lockReleased = false;
    const releaseLock = (): void => {
      if (lockReleased) return;
      lockReleased = true;
      releaseSummarize(key);
    };

    // 客户端中断:只标记结束(停止往已断的 socket 写),【不】在此提早释放锁。
    // 锁一律由下方 finally 在 summarizeChat「真正结束」后释放——LLM 有 timeout,finally 必然会跑。
    // 若在 close 立刻释放,当 LLM 仍在跑时另一请求(尤其非串流路由)可能 acquire 成功 → 同一 key
    // 并发第二次 LLM 呼叫(双倍费用),正是 summarizeGuard 要挡的。故释放权交给 finally,
    // 既保证不泄漏(finally 必跑)又保证跨路径互斥不被破坏。被中断的这次总结仍会照常持久化(不浪费)。
    raw.on('close', () => {
      ended = true;
    });

    const user = req.user;
    const actor = { userId: user?.id ?? null, userName: user?.displayName ?? null };

    try {
      const result = await summarizeChat(chatId, {
        force,
        actor,
        orderId,
        onDelta: (partialSummaryText: string) => sse('delta', { text: partialSummaryText }),
      });
      if (!result.ok) {
        // 未真正调用 LLM 的失败(503/404/400)不占用冷却
        lastSummarizeAt.delete(key);
        sse('error', { error: result.error, status: result.status });
        return endStream();
      }
      if (result.cached) {
        // 回缓存未调 LLM,不占用冷却
        lastSummarizeAt.delete(key);
      }
      sse('done', { summary: result.summary, cached: result.cached });
      endStream();
    } catch (err) {
      // LLM 已被调用(可能已产生费用),保留冷却
      req.log.error(err, 'summarize stream failed');
      const msg = err instanceof Error ? err.message : String(err);
      sse('error', { error: `LLM 调用失败:${msg}`, status: 502 });
      endStream();
    } finally {
      releaseLock();
    }
  });
}
