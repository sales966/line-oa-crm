/**
 * routes/summaryEdit.ts — AI 总结的人工编辑 / 批注(session 认证;全局 hook 已挡未登入)。
 * - PUT  /api/customers/:chatId/summary/:summaryId            body {editedText} → 存人工修改版;editedText 传空=还原
 * - POST /api/customers/:chatId/summary/:summaryId/annotations body {body}       → 加批注(不改原文)
 * - GET  /api/customers/:chatId/summary/:summaryId/annotations                   → 列批注(时间正序)
 * 写操作以 session user 作为审计操作者(summary_edit / summary_annotate)。
 */
import type { FastifyInstance } from 'fastify';
import * as summaryEditService from '../services/summaryEditService.js';

export default async function summaryEditRoutes(app: FastifyInstance): Promise<void> {
  // PUT /api/customers/:chatId/summary/:summaryId — 人工编辑总结(editedText 传空=还原)
  app.put('/api/customers/:chatId/summary/:summaryId', async (req, reply) => {
    const { chatId: rawChatId, summaryId: rawSummaryId } = req.params as {
      chatId: string;
      summaryId: string;
    };
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    const summaryId = Number(rawSummaryId);
    if (!Number.isFinite(summaryId)) return reply.code(400).send({ error: 'summaryId 无效' });

    const user = req.user;
    if (!user) return reply.code(401).send({ error: '未登入' }); // 全局 hook 已挡,此处防御

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { editedText?: unknown };
    const res = summaryEditService.editSummary(chatId, summaryId, body.editedText, {
      userId: user.id,
      userName: user.displayName,
    });
    if (!res.ok) return reply.code(res.status).send({ error: res.error });
    return { ok: true, summary: res.summary };
  });

  // POST /api/customers/:chatId/summary/:summaryId/annotations — 加批注
  app.post('/api/customers/:chatId/summary/:summaryId/annotations', async (req, reply) => {
    const { chatId: rawChatId, summaryId: rawSummaryId } = req.params as {
      chatId: string;
      summaryId: string;
    };
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    const summaryId = Number(rawSummaryId);
    if (!Number.isFinite(summaryId)) return reply.code(400).send({ error: 'summaryId 无效' });

    const user = req.user;
    if (!user) return reply.code(401).send({ error: '未登入' });

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { body?: unknown };
    const res = summaryEditService.addAnnotation(chatId, summaryId, body.body, {
      userId: user.id,
      userName: user.displayName,
    });
    if (!res.ok) return reply.code(res.status).send({ error: res.error });
    return { ok: true, annotation: res.annotation };
  });

  // GET /api/customers/:chatId/summary/:summaryId/annotations — 列批注
  app.get('/api/customers/:chatId/summary/:summaryId/annotations', async (req, reply) => {
    const { chatId: rawChatId, summaryId: rawSummaryId } = req.params as {
      chatId: string;
      summaryId: string;
    };
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    const summaryId = Number(rawSummaryId);
    if (!Number.isFinite(summaryId)) return reply.code(400).send({ error: 'summaryId 无效' });

    return { annotations: summaryEditService.listAnnotations(chatId, summaryId) };
  });
}
