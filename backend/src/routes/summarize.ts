/**
 * routes/summarize.ts — LLM 总结 API。无 key 时 503 {error:'LLM 未配置'}。
 * 防滥用:同一 chatId 有冷却时间(默认 60s,env SUMMARIZE_COOLDOWN_MS 可调),
 * 冷却期内重复请求回 409,避免局域网内循环调用烧掉 LLM API 费用。
 */
import type { FastifyInstance } from 'fastify';
import { summarizeChat } from '../services/summaryService.js';
import { acquireSummarize, releaseSummarize } from '../services/summarizeGuard.js';
import { SUMMARIZE_COOLDOWN_MS } from '../config.js';

/** chatId → 最近一次开始生成的时间(ms);进程内即可,v1 单机单进程 */
const lastSummarizeAt = new Map<string, number>();

export default async function summarizeRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/summarize/:chatId?force=1&orderId=N
  // orderId 缺省或 0 = 整體(既有行为不变);orderId>0 = 该订单总结(隔离路径)。
  // 冷却/互斥锁均按 (chatId, orderId) 分开,整體与各订单互不阻塞。
  app.post('/api/summarize/:chatId', async (req, reply) => {
    const { chatId: rawChatId } = req.params as { chatId: string };
    if (!rawChatId || !rawChatId.trim()) return reply.code(400).send({ error: '缺少 chatId' });
    const chatId = rawChatId.trim();
    const q = (req.query ?? {}) as { force?: string; orderId?: string };
    const force = q.force === '1' || q.force === 'true';
    const oid = Number(q.orderId);
    const orderId = Number.isFinite(oid) && Math.trunc(oid) > 0 ? Math.trunc(oid) : 0;
    // 冷却/锁的键:整體=chatId;订单=chatId#orderId
    const key = orderId > 0 ? `${chatId}#${orderId}` : chatId;

    const now = Date.now();
    const last = lastSummarizeAt.get(key);
    if (last !== undefined && now - last < SUMMARIZE_COOLDOWN_MS) {
      const waitSec = Math.ceil((SUMMARIZE_COOLDOWN_MS - (now - last)) / 1000);
      return reply.code(409).send({ error: `總結生成過於頻繁,請 ${waitSec} 秒後再試` });
    }
    // 跨路径互斥:若建档 done 的自动总结(或另一请求)正在跑同一 key,拒绝并发,
    // 避免两次 LLM 各插一行 summaries。锁与 ingest 建档路径共用(整體 key=chatId)。
    if (!acquireSummarize(key)) {
      return reply.code(409).send({ error: '該客戶正在生成總結,請稍候再試' });
    }

    // 先占位:同时挡住冷却期内的并发重复请求
    lastSummarizeAt.set(key, now);

    const user = req.user;
    const actor = { userId: user?.id ?? null, userName: user?.displayName ?? null };
    try {
      const result = await summarizeChat(chatId, { force, actor, orderId });
      if (!result.ok) {
        // 未真正调用 LLM 的失败(503 未配置 / 404 不存在 / 400 无内容)不占用冷却
        lastSummarizeAt.delete(key);
        return reply.code(result.status).send({ error: result.error });
      }
      if (result.cached) {
        // 回缓存未调 LLM,不占用冷却
        lastSummarizeAt.delete(key);
        return { summary: result.summary, cached: true };
      }
      return { summary: result.summary };
    } catch (err) {
      // LLM 已被调用(可能已产生费用),保留冷却
      req.log.error(err, 'summarize failed');
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `LLM 调用失败:${msg}` });
    } finally {
      releaseSummarize(key);
    }
  });
}
