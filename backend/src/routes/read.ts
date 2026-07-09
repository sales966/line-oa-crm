/**
 * routes/read.ts — UI 读取 API(webui → backend)。
 */
import type { FastifyInstance } from 'fastify';
import * as chatService from '../services/chatService.js';
import * as fileService from '../services/fileService.js';
import * as teamChatService from '../services/teamChatService.js';
import * as orderService from '../services/orderService.js';

/** query.orderId → 正整数(0/缺省=整體) */
function parseOrderId(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && Math.trunc(n) > 0 ? Math.trunc(n) : 0;
}

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

  // GET /api/customers/:chatId/messages?before=&beforeId=&limit=100&orderId=N
  // keyset 分页:before + beforeId 为上一页最后一条的 (timestamp, id) 复合游标
  // orderId>0:仅回该订单 [fromDate,toDate] 日期范围内的消息;orderId=0/缺省=整體(行为不变)
  app.get('/api/customers/:chatId/messages', async (req, reply) => {
    const { chatId } = req.params as { chatId: string };
    const q = req.query as { before?: string; beforeId?: string; limit?: string; orderId?: string };
    const opts = {
      before: q.before !== undefined ? Number(q.before) : undefined,
      beforeId: q.beforeId !== undefined ? Number(q.beforeId) : undefined,
      limit: q.limit !== undefined ? Number(q.limit) : undefined,
    };
    const orderId = parseOrderId(q.orderId);
    if (orderId > 0) {
      const messages = orderService.listOrderMessages(chatId, orderId, opts);
      if (messages === null) return reply.code(404).send({ error: '订单不存在' });
      return { messages };
    }
    return { messages: chatService.listMessages(chatId, opts) };
  });

  // GET /api/customers/:chatId/files
  // files:每档含 docRole/source/downloadUrl;missing:缺档补件占位清单
  //(messages 有 contentHash 但 files 无实体、未过期者)。只加字段,不破坏既有形状。
  app.get('/api/customers/:chatId/files', async (req) => {
    const { chatId } = req.params as { chatId: string };
    return { files: fileService.listFiles(chatId), missing: fileService.listMissingWall(chatId) };
  });

  // GET /api/customers/:chatId/notes
  app.get('/api/customers/:chatId/notes', async (req) => {
    const { chatId } = req.params as { chatId: string };
    return { notes: chatService.listNotes(chatId) };
  });

  // GET /api/customers/:chatId/summaries?orderId=N
  // orderId>0:该订单的总结历史;orderId=0/缺省=整體(仅整體总结,行为不变)
  app.get('/api/customers/:chatId/summaries', async (req) => {
    const { chatId } = req.params as { chatId: string };
    const q = req.query as { orderId?: string };
    const orderId = parseOrderId(q.orderId);
    if (orderId > 0) return { summaries: orderService.listOrderSummaries(chatId, orderId) };
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
