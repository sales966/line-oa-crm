/**
 * routes/progress.ts — 进度表 API(session 认证;全局 auth hook 已装饰 req.user)。
 * - GET  /api/customers/:chatId/progress
 * - PUT  /api/customers/:chatId/progress/task/:taskKey  {done}
 * - PUT  /api/customers/:chatId/progress/meta           {stageOverride?,...}
 * 写操作经 progressService,内部统一记 audit(带 session user)。
 */
import type { FastifyInstance } from 'fastify';
import * as progressService from '../services/progressService.js';

export default async function progressRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/customers/:chatId/progress
  app.get('/api/customers/:chatId/progress', async (req, reply) => {
    const { chatId: rawChatId } = req.params as { chatId: string };
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    return progressService.getProgress(chatId);
  });

  // PUT /api/customers/:chatId/progress/task/:taskKey  body {done}
  app.put('/api/customers/:chatId/progress/task/:taskKey', async (req, reply) => {
    const { chatId: rawChatId, taskKey: rawTaskKey } = req.params as {
      chatId: string;
      taskKey: string;
    };
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    const taskKey = typeof rawTaskKey === 'string' ? rawTaskKey.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    if (!taskKey) return reply.code(400).send({ error: '缺少 taskKey' });

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      done?: unknown;
      evidence?: unknown;
    };
    const done = body.done === true || body.done === 1 || body.done === '1' || body.done === 'true';
    // evidence 未带 → undefined(不动既有证据);带字符串(含空)→ 人工补/改证据
    const evidence =
      'evidence' in body
        ? typeof body.evidence === 'string'
          ? body.evidence
          : ''
        : undefined;

    const user = req.user;
    const res = progressService.setTask(
      chatId,
      taskKey,
      done,
      { userId: user?.id ?? null, userName: user?.displayName ?? null },
      evidence
    );
    if (!res.ok) return reply.code(res.status).send({ error: res.error });
    return { ok: true, task: res.task };
  });

  // PUT /api/customers/:chatId/progress/meta  body {stageOverride?,sampleLeadDays?,...}
  app.put('/api/customers/:chatId/progress/meta', async (req, reply) => {
    const { chatId: rawChatId } = req.params as { chatId: string };
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });

    const patch = (req.body && typeof req.body === 'object' ? req.body : {}) as progressService.MetaPatch;
    const user = req.user;
    const res = progressService.setMeta(chatId, patch, {
      userId: user?.id ?? null,
      userName: user?.displayName ?? null,
    });
    if (!res.ok) return reply.code(res.status).send({ error: res.error });
    return { ok: true, progress: res.progress };
  });
}
