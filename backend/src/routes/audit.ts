/**
 * routes/audit.ts — 审计查询(session 认证;全局 hook 已挡未登入)。
 * - GET /api/customers/:chatId/audit → {logs:[{userName,action,target,detail,createdAt,...}]} 倒序
 * webui 客户详情「📜 變更紀錄」用之;所有写操作由各自 service 调 recordAudit 写入。
 */
import type { FastifyInstance } from 'fastify';
import {
  listAudit,
  listAllAudit,
  listAuditActions,
  listAuditUsers,
} from '../services/auditService.js';

export default async function auditRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/customers/:chatId/audit — 该客户的变更纪录(createdAt 倒序)
  app.get('/api/customers/:chatId/audit', async (req, reply) => {
    const { chatId: rawChatId } = req.params as { chatId: string };
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    return { logs: listAudit(chatId) };
  });

  // GET /api/audit — 全局审计检视(仅管理角色;非管理 403)
  // query: limit=100 & userId= & action= & chatId=
  app.get('/api/audit', async (req, reply) => {
    const user = req.user;
    if (!user) return reply.code(401).send({ error: '未登入' });
    if (user.role !== '管理') return reply.code(403).send({ error: '僅限管理角色' });

    const q = (req.query && typeof req.query === 'object' ? req.query : {}) as {
      limit?: string;
      userId?: string;
      action?: string;
      chatId?: string;
    };

    const limit = q.limit != null && q.limit !== '' ? Number(q.limit) : undefined;
    const userIdNum = q.userId != null && q.userId !== '' ? Number(q.userId) : undefined;
    const userId = userIdNum !== undefined && Number.isFinite(userIdNum) ? userIdNum : undefined;
    const action = typeof q.action === 'string' && q.action.trim() ? q.action.trim() : undefined;
    const chatId = typeof q.chatId === 'string' && q.chatId.trim() ? q.chatId.trim() : undefined;

    return {
      logs: listAllAudit({ limit, userId, action, chatId }),
      actions: listAuditActions(),
      users: listAuditUsers(),
    };
  });
}
