/**
 * routes/docrole.ts — 人工设定档案角色(session 认证;全局 auth hook 已装饰 req.user)。
 * - PUT /api/customers/:chatId/files/:fileId/docRole  {docRole}
 *   人工指派 files.docRole + docRoleSource='manual'(LLM 不再覆盖),记 file_docrole 审计。
 * 写操作经 docRoleService(routes 不直接碰 db)。协调者统一挂载,勿改 server.ts。
 */
import type { FastifyInstance } from 'fastify';
import * as docRoleService from '../services/docRoleService.js';

export default async function docRoleRoutes(app: FastifyInstance): Promise<void> {
  // PUT /api/customers/:chatId/files/:fileId/docRole  body {docRole}
  app.put('/api/customers/:chatId/files/:fileId/docRole', async (req, reply) => {
    const { chatId: rawChatId, fileId: rawFileId } = req.params as {
      chatId: string;
      fileId: string;
    };
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    const fileId = Number(rawFileId);

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { docRole?: unknown };
    const user = req.user;
    const res = docRoleService.setManualFileDocRole(chatId, fileId, body.docRole, {
      userId: user?.id ?? null,
      userName: user?.displayName ?? null,
    });
    if (!res.ok) return reply.code(res.status).send({ error: res.error });
    return { ok: true, file: res.file };
  });
}
