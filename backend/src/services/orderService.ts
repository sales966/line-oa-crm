/**
 * orderService.ts — 订单 CRUD(一客户多张订单,各自日期范围 + 各自总结/进度)。
 * routes 不直接碰 db;所有写操作记 audit(action=order_*,带 session user)。
 * 隔离式:订单进度存 order_stage_tasks / order_stage_meta;删除订单连带清这两表 + summaries(orderId=该单)。
 */
import db from '../db.js';
import { recordAudit, type AuditActor } from './auditService.js';
import { computeOrderStage } from './orderProgressService.js';
import type { StageName } from '../stageTemplate.js';
import { PAGE_LIMIT_MAX } from '../config.js';

export interface OrderRow {
  id: number;
  lineChatId: string;
  title: string | null;
  fromDate: number | null;
  toDate: number | null;
  createdByName: string | null;
  /** 建立者稳定 userId(授权凭据;createdByName 仅显示用)。旧行可能为 NULL。 */
  createdByUserId: number | null;
  createdAt: number | null;
  updatedAt: number | null;
}

/** 权限用 actor:含 role(管理可删任意订单;否则仅建立者本人) */
export interface OrderActor extends AuditActor {
  role?: string | null;
}

const toInt = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** epoch ms → M/D(本地时区);用于订单预设标题 */
function md(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 预设标题:「訂單 M/D~M/D」;缺日期时优雅降级 */
function defaultTitle(fromDate: number | null, toDate: number | null): string {
  if (fromDate != null && toDate != null) return `訂單 ${md(fromDate)}~${md(toDate)}`;
  if (fromDate != null) return `訂單 ${md(fromDate)}~`;
  if (toDate != null) return `訂單 ~${md(toDate)}`;
  return '訂單';
}

const customerExistsStmt = db.prepare('SELECT id FROM customers WHERE lineChatId = ?');
const insertOrderStmt = db.prepare(`
  INSERT INTO orders (lineChatId, title, fromDate, toDate, createdByName, createdByUserId, createdAt, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const getOrderStmt = db.prepare('SELECT * FROM orders WHERE id = ?');
const listOrdersStmt = db.prepare(
  'SELECT * FROM orders WHERE lineChatId = ? ORDER BY createdAt DESC, id DESC'
);
const updateOrderStmt = db.prepare(
  'UPDATE orders SET title = ?, fromDate = ?, toDate = ?, updatedAt = ? WHERE id = ?'
);
const deleteOrderStmt = db.prepare('DELETE FROM orders WHERE id = ?');
const deleteOrderTasksStmt = db.prepare('DELETE FROM order_stage_tasks WHERE orderId = ?');
const deleteOrderMetaStmt = db.prepare('DELETE FROM order_stage_meta WHERE orderId = ?');
const deleteOrderSummariesStmt = db.prepare('DELETE FROM summaries WHERE orderId = ?');

/** 取单笔订单(不校验归属) */
export function getOrder(orderId: number): OrderRow | undefined {
  return getOrderStmt.get(orderId) as OrderRow | undefined;
}

/** 取单笔订单并校验归属于该 chat;不符回 undefined */
export function getOrderInChat(chatId: string, orderId: number): OrderRow | undefined {
  const row = getOrderStmt.get(orderId) as OrderRow | undefined;
  if (!row || row.lineChatId !== chatId) return undefined;
  return row;
}

export interface OrderWithStage extends OrderRow {
  currentStage: StageName;
}

/** 列出某客户全部订单(倒序);附带各订单的 currentStage(纯计算,方便列表直接显示) */
export function listOrders(chatId: string): OrderWithStage[] {
  const rows = listOrdersStmt.all(chatId) as OrderRow[];
  return rows.map((r) => ({ ...r, currentStage: computeOrderStage(r.id) }));
}

export interface CreateOrderInput {
  title?: unknown;
  fromDate?: unknown;
  toDate?: unknown;
}

export type CreateOrderResult =
  | { ok: true; order: OrderRow }
  | { ok: false; status: number; error: string };

export function createOrder(chatId: string, input: CreateOrderInput, actor: OrderActor): CreateOrderResult {
  if (!chatId) return { ok: false, status: 400, error: '缺少 chatId' };
  if (!customerExistsStmt.get(chatId)) return { ok: false, status: 404, error: '客户不存在' };

  const fromDate = toInt(input.fromDate);
  const toDate = toInt(input.toDate);
  // 后端校验:两端皆有时 fromDate 不得晚于 toDate(否则 BETWEEN lo>hi 静默返回空集,订单看似坏掉)
  if (fromDate != null && toDate != null && fromDate > toDate) {
    return { ok: false, status: 400, error: 'fromDate 不得晚於 toDate' };
  }
  const rawTitle = typeof input.title === 'string' ? input.title.trim() : '';
  const title = rawTitle || defaultTitle(fromDate, toDate);
  const now = Date.now();
  const createdByName = typeof actor.userName === 'string' && actor.userName ? actor.userName : null;
  const createdByUserId = typeof actor.userId === 'number' ? actor.userId : null;

  const res = insertOrderStmt.run(chatId, title, fromDate, toDate, createdByName, createdByUserId, now, now);
  const id = Number(res.lastInsertRowid);
  const order = getOrderStmt.get(id) as OrderRow;

  recordAudit(chatId, actor, 'order_create', String(id), { orderId: id, title, fromDate, toDate });
  return { ok: true, order };
}

export interface UpdateOrderInput {
  title?: unknown;
  fromDate?: unknown;
  toDate?: unknown;
}

export type UpdateOrderResult =
  | { ok: true; order: OrderRow }
  | { ok: false; status: number; error: string };

export function updateOrder(
  chatId: string,
  orderId: number,
  input: UpdateOrderInput,
  actor: OrderActor
): UpdateOrderResult {
  const prev = getOrderInChat(chatId, orderId);
  if (!prev) return { ok: false, status: 404, error: '订单不存在' };

  const fromDate = 'fromDate' in input ? toInt(input.fromDate) : prev.fromDate;
  const toDate = 'toDate' in input ? toInt(input.toDate) : prev.toDate;
  // 后端校验:两端皆有时 fromDate 不得晚于 toDate(与 createOrder 一致)
  if (fromDate != null && toDate != null && fromDate > toDate) {
    return { ok: false, status: 400, error: 'fromDate 不得晚於 toDate' };
  }
  let title = prev.title;
  if ('title' in input) {
    const rawTitle = typeof input.title === 'string' ? input.title.trim() : '';
    title = rawTitle || defaultTitle(fromDate, toDate);
  }
  const now = Date.now();
  updateOrderStmt.run(title, fromDate, toDate, now, orderId);
  const order = getOrderStmt.get(orderId) as OrderRow;

  recordAudit(chatId, actor, 'order_update', String(orderId), {
    orderId,
    before: { title: prev.title, fromDate: prev.fromDate, toDate: prev.toDate },
    after: { title, fromDate, toDate },
  });
  return { ok: true, order };
}

export type DeleteOrderResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/** 删除订单(仅管理或建立者本人);连带清 order_stage_tasks/order_stage_meta + summaries(orderId=该单) */
export function deleteOrder(chatId: string, orderId: number, actor: OrderActor): DeleteOrderResult {
  const prev = getOrderInChat(chatId, orderId);
  if (!prev) return { ok: false, status: 404, error: '订单不存在' };

  const isAdmin = actor.role === '管理';
  // 归属用稳定 userId 判定(displayName 非 UNIQUE 且可改名,不可作授权凭据)。
  // 旧订单 createdByUserId 为 NULL 时不认定任何人为建立者(仅管理可删)。
  const isCreator =
    typeof actor.userId === 'number' && prev.createdByUserId != null && actor.userId === prev.createdByUserId;
  if (!isAdmin && !isCreator) {
    return { ok: false, status: 403, error: '仅管理或建立者可删除此订单' };
  }

  const tx = db.transaction(() => {
    deleteOrderTasksStmt.run(orderId);
    deleteOrderMetaStmt.run(orderId);
    deleteOrderSummariesStmt.run(orderId);
    deleteOrderStmt.run(orderId);
  });
  tx();

  recordAudit(chatId, actor, 'order_delete', String(orderId), {
    orderId,
    title: prev.title,
    fromDate: prev.fromDate,
    toDate: prev.toDate,
  });
  return { ok: true };
}

// ── 订单范围读取(消息 / 总结)────────────────────────────────────────────
// 订单不在 messages 上打标记,而是按订单 [fromDate,toDate] 时间范围过滤。
// fromDate/toDate 为 null 时该端不设界(0 / MAX_SAFE_INTEGER)。

// 与 chatService.listMessages 相同的 keyset (timestamp,id) 复合游标,额外夹在订单日期范围内
const listOrderMsgsStmt = db.prepare(
  `SELECT * FROM messages
   WHERE lineChatId = ? AND timestamp BETWEEN ? AND ?
   ORDER BY timestamp DESC, id DESC LIMIT ?`
);
const listOrderMsgsBeforeIdStmt = db.prepare(
  `SELECT * FROM messages
   WHERE lineChatId = ? AND timestamp BETWEEN ? AND ?
     AND (timestamp < ? OR (timestamp = ? AND id < ?))
   ORDER BY timestamp DESC, id DESC LIMIT ?`
);

/** 列出某订单日期范围内的消息(倒序,keyset 分页);order 不存在或不属该 chat 回 null */
export function listOrderMessages(
  chatId: string,
  orderId: number,
  opts: { before?: number; beforeId?: number; limit?: number }
): unknown[] | null {
  const order = getOrderInChat(chatId, orderId);
  if (!order) return null;
  const lo = order.fromDate ?? 0;
  const hi = order.toDate ?? Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Math.max(toInt(opts.limit) ?? 100, 1), PAGE_LIMIT_MAX);
  const before = toInt(opts.before);
  const beforeId = toInt(opts.beforeId);
  if (before !== null && beforeId !== null) {
    return listOrderMsgsBeforeIdStmt.all(chatId, lo, hi, before, before, beforeId, limit) as unknown[];
  }
  return listOrderMsgsStmt.all(chatId, lo, hi, limit) as unknown[];
}

interface SummaryDbRow {
  id: number;
  lineChatId: string;
  summaryText: string | null;
  stageGuess: string | null;
  keyFacts: string | null;
  nextActions: string | null;
  model: string | null;
  coveredUntilTs: number | null;
  createdAt: number | null;
}

const listOrderSummariesStmt = db.prepare(
  'SELECT * FROM summaries WHERE lineChatId = ? AND orderId = ? ORDER BY createdAt DESC, id DESC'
);

/** 列出某订单的总结历史;keyFacts/nextActions 解析成对象(与整體 listSummaries 回传形状一致) */
export function listOrderSummaries(chatId: string, orderId: number): unknown[] {
  const rows = listOrderSummariesStmt.all(chatId, orderId) as SummaryDbRow[];
  return rows.map((r) => {
    let nextActions: unknown = [];
    try {
      nextActions = r.nextActions ? JSON.parse(r.nextActions) : [];
    } catch {
      nextActions = [];
    }
    let keyFacts: unknown = {};
    try {
      keyFacts = r.keyFacts ? JSON.parse(r.keyFacts) : {};
    } catch {
      keyFacts = {};
    }
    return { ...r, nextActions, keyFacts };
  });
}
