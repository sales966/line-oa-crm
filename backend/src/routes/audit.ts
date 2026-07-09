/**
 * routes/audit.ts — 审计查询(session 认证;全局 hook 已挡未登入)。
 * - GET /api/customers/:chatId/audit → {logs:[{userName,action,target,detail,createdAt,...}]} 倒序
 * webui 客户详情「📜 變更紀錄」用之;所有写操作由各自 service 调 recordAudit 写入。
 */
import type { FastifyInstance } from 'fastify';
import { listAudit } from '../services/auditService.js';

export default async function auditRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/customers/:chatId/audit — 该客户的变更纪录(createdAt 倒序)
  app.get('/api/customers/:chatId/audit', async (req, reply) => {
    const { chatId: rawChatId } = req.params as { chatId: string };
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    return { logs: listAudit(chatId) };
  });
}
