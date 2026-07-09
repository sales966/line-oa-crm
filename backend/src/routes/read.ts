/**
 * routes/read.ts — UI 读取 API(webui → backend)。
 */
import type { FastifyInstance } from 'fastify';
import * as chatService from '../services/chatService.js';
import * as fileService from '../services/fileService.js';
import * as teamChatService from '../services/teamChatService.js';

export default async function readRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/customers?q=&stage=&sort=lastMessageAt
  app.get('/api/customers', async (req) => {
    const q = req.query as { q?: string; stage?: string; sort?: string };
    return { customers: chatService.listCustomers({ q: q.q, stage: q.stage, sort: q.sort }) };
  });

  // GET /api/customers/:chatId
  app.get('/api/customers/:chatId', async (req, reply) => {
    const { chatId } = req.params as { chatId: string };
    const customer = chatService.getCustomer(chatId);
    if (!customer) return reply.code(404).send({ error: '客户不存在' });
    return { customer };
  });

  // GET /api/customers/:chatId/messages?before=&beforeId=&limit=100
  // keyset 分页:before + beforeId 为上一页最后一条的 (timestamp, id) 复合游标
  app.get('/api/customers/:chatId/messages', async (req) => {
    const { chatId } = req.params as { chatId: string };
    const q = req.query as { before?: string; beforeId?: string; limit?: string };
    return {
      messages: chatService.listMessages(chatId, {
        before: q.before !== undefined ? Number(q.before) : undefined,
        beforeId: q.beforeId !== undefined ? Number(q.beforeId) : undefined,
        limit: q.limit !== undefined ? Number(q.limit) : undefined,
      }),
    };
  });

  // GET /api/customers/:chatId/files
  app.get('/api/customers/:chatId/files', async (req) => {
    const { chatId } = req.params as { chatId: string };
    return { files: fileService.listFiles(chatId) };
  });

  // GET /api/customers/:chatId/notes
  app.get('/api/customers/:chatId/notes', async (req) => {
    const { chatId } = req.params as { chatId: string };
    return { notes: chatService.listNotes(chatId) };
  });

  // GET /api/customers/:chatId/summaries
  app.get('/api/customers/:chatId/summaries', async (req) => {
    const { chatId } = req.params as { chatId: string };
    return { summaries: chatService.listSummaries(chatId) };
  });

  // GET /api/customers/:chatId/team-messages?after=&limit=100 — 团队内部讨论(createdAt 升序;after=上次最大 id,增量轮询)
  app.get('/api/customers/:chatId/team-messages', async (req) => {
    const { chatId } = req.params as { chatId: string };
    const q = req.query as { after?: string; limit?: string };
    return {
      messages: teamChatService.listTeamMessages(chatId, {
        after: q.after !== undefined ? Number(q.after) : undefined,
        limit: q.limit !== undefined ? Number(q.limit) : undefined,
      }),
    };
  });

  // POST /api/customers/:chatId/team-messages — 新增内部讨论(body 去空白不得为空)
  // 发言人身份以 session user 强制覆盖 authorName/authorRole/userId(忽略 body 里的同名字段,形状兼容)
  app.post('/api/customers/:chatId/team-messages', async (req, reply) => {
    const { chatId: rawChatId } = req.params as { chatId: string };
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    const user = req.user;
    if (!user) return reply.code(401).send({ error: '未登入' }); // 全局 hook 已挡,此处防御
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      body?: unknown;
      mentions?: unknown;
    };
    const res = teamChatService.addTeamMessage(chatId, body, {
      userId: user.id,
      name: user.displayName,
      role: user.role,
    });
    if (!res.ok) return reply.code(400).send({ error: res.error });
    return { ok: true, message: res.message };
  });

  // POST /api/customers/:chatId/full-sync — webui 触发按需建档(upsert 为 pending)
  app.post('/api/customers/:chatId/full-sync', async (req, reply) => {
    const { chatId: rawChatId } = req.params as { chatId: string };
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    chatService.requestFullSync(chatId);
    return { ok: true };
  });

  // GET /api/customers/:chatId/full-sync — 建档状态
  app.get('/api/customers/:chatId/full-sync', async (req, reply) => {
    const { chatId: rawChatId } = req.params as { chatId: string };
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    return chatService.getFullSyncStatus(chatId);
  });
}
