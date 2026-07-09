/**
 * routes/batch.ts — 批次建檔(session 认证;全局 auth hook 已保证 req.user 存在)。
 * - POST /api/customers/batch-full-sync {chatIds:[...]} → 对每个 chatId upsert sync_requests 为 pending
 *   (复用 chatService.requestFullSync);回 {ok:true, queued:N}。
 * 校验:chatIds 必须为数组;去空白/去重;上限 200(超出回 400)。
 * 记 audit:action=batch_full_sync(lineChatId=null,批次层级),detail={queued, chatIds}。
 */
import type { FastifyInstance } from 'fastify';
import * as chatService from '../services/chatService.js';
import { recordAudit } from '../services/auditService.js';

const BATCH_MAX = 200;

export default async function batchRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/customers/batch-full-sync  body {chatIds:[...]}
  app.post('/api/customers/batch-full-sync', async (req, reply) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { chatIds?: unknown };
    if (!Array.isArray(body.chatIds)) {
      return reply.code(400).send({ error: 'chatIds 必須為陣列' });
    }

    // 去空白 + 去重(保序):只收非空字串
    const seen = new Set<string>();
    const chatIds: string[] = [];
    for (const raw of body.chatIds) {
      if (typeof raw !== 'string') continue;
      const chatId = raw.trim();
      if (!chatId || seen.has(chatId)) continue;
      seen.add(chatId);
      chatIds.push(chatId);
    }

    if (chatIds.length === 0) {
      return reply.code(400).send({ error: 'chatIds 不得為空' });
    }
    if (chatIds.length > BATCH_MAX) {
      return reply.code(400).send({ error: `一次最多 ${BATCH_MAX} 筆,實收 ${chatIds.length} 筆` });
    }

    for (const chatId of chatIds) {
      chatService.requestFullSync(chatId);
    }

    const user = req.user;
    recordAudit(
      null,
      { userId: user?.id ?? null, userName: user?.displayName ?? null },
      'batch_full_sync',
      null,
      { queued: chatIds.length, chatIds }
    );

    return { ok: true, queued: chatIds.length };
  });
}
