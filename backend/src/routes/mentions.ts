/**
 * routes/mentions.ts — 内部讨论 @ 提及:自动完成 + 我的通知(session 认证)。
 * - GET  /api/customers/:chatId/mentions/suggest?q=  → {users:[{id,displayName,role}], files:[{id,fileName}]}
 * - GET  /api/me/mentions?unreadOnly=1               → {mentions:[{id,lineChatId,chatName,snippet,createdAt,readAt}]}
 * - POST /api/me/mentions/read  {ids}                → {ok:true, updated}
 * 全局 auth hook 已保证 req.user 存在(未登入 401)。
 */
import type { FastifyInstance } from 'fastify';
import * as mentionsService from '../services/mentionsService.js';

export default async function mentionsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/customers/:chatId/mentions/suggest?q= — @ 自动完成
  app.get('/api/customers/:chatId/mentions/suggest', async (req, reply) => {
    const { chatId: rawChatId } = req.params as { chatId: string };
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    const q = (req.query as { q?: string }).q ?? '';
    return mentionsService.suggest(chatId, q);
  });

  // GET /api/me/mentions?unreadOnly=1 — 我被 @ 的清单(仅 user 提及)
  app.get('/api/me/mentions', async (req, reply) => {
    const user = req.user;
    if (!user) return reply.code(401).send({ error: '未登入' });
    const unreadOnly = (req.query as { unreadOnly?: string }).unreadOnly === '1';
    return { mentions: mentionsService.listMyMentions(user.id, unreadOnly) };
  });

  // POST /api/me/mentions/read {ids} — 标记已读(只动属于我的未读项)
  app.post('/api/me/mentions/read', async (req, reply) => {
    const user = req.user;
    if (!user) return reply.code(401).send({ error: '未登入' });
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { ids?: unknown };
    const updated = mentionsService.markRead(user.id, body.ids);
    return { ok: true, updated };
  });
}
