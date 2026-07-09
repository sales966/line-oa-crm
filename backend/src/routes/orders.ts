/**
 * routes/orders.ts — 订单 API(Fastify plugin;session 认证,全局 auth hook 已装饰 req.user)。
 * 订单 CRUD:
 * - GET    /api/customers/:chatId/orders
 * - POST   /api/customers/:chatId/orders                {title?,fromDate?,toDate?}
 * - PUT    /api/customers/:chatId/orders/:orderId       {title?,fromDate?,toDate?}
 * - DELETE /api/customers/:chatId/orders/:orderId       (仅管理或建立者)
 * 订单进度(平行 /progress,键为 orderId;orderId 必填 >0,=0 请走既有 /progress):
 * - GET /api/customers/:chatId/order-progress?orderId=N
 * - PUT /api/customers/:chatId/order-progress/task/:taskKey?orderId=N   {done,evidence?}
 * - PUT /api/customers/:chatId/order-progress/meta?orderId=N           {stageOverride?,...}
 * 写操作经 orderService / orderProgressService,内部统一记 audit(带 session user)。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as orderService from '../services/orderService.js';
import * as orderProgress from '../services/orderProgressService.js';
import type { OrderActor } from '../services/orderService.js';
import type { MetaPatch } from '../services/progressService.js';

function trimChatId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** 由 session user 组 actor(含 role,供删除权限判定) */
function actorOf(req: FastifyRequest): OrderActor {
  const u = req.user;
  return { userId: u?.id ?? null, userName: u?.displayName ?? null, role: u?.role ?? null };
}

/** 解析并校验 query.orderId(必填、正整数);无效回 null */
function parseOrderId(req: FastifyRequest): number | null {
  const q = (req.query ?? {}) as { orderId?: unknown };
  const n = Number(q.orderId);
  if (!Number.isFinite(n) || Math.trunc(n) <= 0) return null;
  return Math.trunc(n);
}

export default async function orderRoutes(app: FastifyInstance): Promise<void> {
  // ── 订单 CRUD ──────────────────────────────────────────────────────────
  // GET /api/customers/:chatId/orders
  app.get('/api/customers/:chatId/orders', async (req, reply) => {
    const chatId = trimChatId((req.params as { chatId: string }).chatId);
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    return { orders: orderService.listOrders(chatId) };
  });

  // POST /api/customers/:chatId/orders  body {title?,fromDate?,toDate?}
  app.post('/api/customers/:chatId/orders', async (req, reply) => {
    const chatId = trimChatId((req.params as { chatId: string }).chatId);
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as orderService.CreateOrderInput;
    const res = orderService.createOrder(chatId, body, actorOf(req));
    if (!res.ok) return reply.code(res.status).send({ error: res.error });
    return reply.code(201).send({ ok: true, order: res.order });
  });

  // PUT /api/customers/:chatId/orders/:orderId  body {title?,fromDate?,toDate?}
  app.put('/api/customers/:chatId/orders/:orderId', async (req, reply) => {
    const { chatId: rawChatId, orderId: rawOrderId } = req.params as { chatId: string; orderId: string };
    const chatId = trimChatId(rawChatId);
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    const orderId = Number(rawOrderId);
    if (!Number.isFinite(orderId) || Math.trunc(orderId) <= 0) {
      return reply.code(400).send({ error: '无效的 orderId' });
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as orderService.UpdateOrderInput;
    const res = orderService.updateOrder(chatId, Math.trunc(orderId), body, actorOf(req));
    if (!res.ok) return reply.code(res.status).send({ error: res.error });
    return { ok: true, order: res.order };
  });

  // DELETE /api/customers/:chatId/orders/:orderId  (仅管理或建立者)
  app.delete('/api/customers/:chatId/orders/:orderId', async (req, reply) => {
    const { chatId: rawChatId, orderId: rawOrderId } = req.params as { chatId: string; orderId: string };
    const chatId = trimChatId(rawChatId);
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    const orderId = Number(rawOrderId);
    if (!Number.isFinite(orderId) || Math.trunc(orderId) <= 0) {
      return reply.code(400).send({ error: '无效的 orderId' });
    }
    const res = orderService.deleteOrder(chatId, Math.trunc(orderId), actorOf(req));
    if (!res.ok) return reply.code(res.status).send({ error: res.error });
    return { ok: true };
  });

  // ── 订单进度 ───────────────────────────────────────────────────────────
  // GET /api/customers/:chatId/order-progress?orderId=N
  app.get('/api/customers/:chatId/order-progress', async (req, reply) => {
    const chatId = trimChatId((req.params as { chatId: string }).chatId);
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    const orderId = parseOrderId(req);
    if (orderId === null) return reply.code(400).send({ error: 'orderId 必填且须为正整数' });
    if (!orderService.getOrderInChat(chatId, orderId)) {
      return reply.code(404).send({ error: '订单不存在' });
    }
    return orderProgress.getOrderProgress(orderId);
  });

  // PUT /api/customers/:chatId/order-progress/task/:taskKey?orderId=N  body {done,evidence?}
  app.put('/api/customers/:chatId/order-progress/task/:taskKey', async (req, reply) => {
    const { chatId: rawChatId, taskKey: rawTaskKey } = req.params as { chatId: string; taskKey: string };
    const chatId = trimChatId(rawChatId);
    const taskKey = typeof rawTaskKey === 'string' ? rawTaskKey.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    if (!taskKey) return reply.code(400).send({ error: '缺少 taskKey' });
    const orderId = parseOrderId(req);
    if (orderId === null) return reply.code(400).send({ error: 'orderId 必填且须为正整数' });
    if (!orderService.getOrderInChat(chatId, orderId)) {
      return reply.code(404).send({ error: '订单不存在' });
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      done?: unknown;
      evidence?: unknown;
    };
    const done = body.done === true || body.done === 1 || body.done === '1' || body.done === 'true';
    const evidence =
      'evidence' in body ? (typeof body.evidence === 'string' ? body.evidence : '') : undefined;

    const res = orderProgress.setOrderTask(chatId, orderId, taskKey, done, actorOf(req), evidence);
    if (!res.ok) return reply.code(res.status).send({ error: res.error });
    return { ok: true, task: res.task };
  });

  // PUT /api/customers/:chatId/order-progress/meta?orderId=N  body {stageOverride?,...}
  app.put('/api/customers/:chatId/order-progress/meta', async (req, reply) => {
    const chatId = trimChatId((req.params as { chatId: string }).chatId);
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    const orderId = parseOrderId(req);
    if (orderId === null) return reply.code(400).send({ error: 'orderId 必填且须为正整数' });
    if (!orderService.getOrderInChat(chatId, orderId)) {
      return reply.code(404).send({ error: '订单不存在' });
    }

    const patch = (req.body && typeof req.body === 'object' ? req.body : {}) as MetaPatch;
    const res = orderProgress.setOrderMeta(chatId, orderId, patch, actorOf(req));
    if (!res.ok) return reply.code(res.status).send({ error: res.error });
    return { ok: true, progress: res.progress };
  });
}
