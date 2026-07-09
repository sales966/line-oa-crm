/**
 * routes/usage.ts — LLM 用量查询 API(session 认证;仅 role=管理)。
 * 全局 auth hook 已保证 session 有效并装饰 req.user;此处再加角色门槛(非管理回 403)。
 * - GET /api/usage/summary?days=30 → {summary:[{date,count,okCount,failCount,avgMs,totalMs},...]}
 * - GET /api/usage/recent?limit=50 → {recent:[...]}
 * 只读经 usageService(routes 不直接碰 db)。协调者统一挂载,勿改 server.ts。
 */
import type { FastifyInstance } from 'fastify';
import * as usageService from '../services/usageService.js';

export default async function usageRoutes(app: FastifyInstance): Promise<void> {
  // 本 plugin 内所有路由:仅限管理(fastify 封装作用域,不影响其他路由)
  app.addHook('onRequest', async (req, reply) => {
    if (!req.user || req.user.role !== '管理') {
      reply.code(403).send({ error: '僅限管理角色' });
    }
  });

  // GET /api/usage/summary?days=30 — 近 days 天按天聚合
  app.get('/api/usage/summary', async (req) => {
    const q = (req.query && typeof req.query === 'object' ? req.query : {}) as { days?: unknown };
    const days = Number(q.days);
    return { summary: usageService.summary(Number.isFinite(days) ? days : 30) };
  });

  // GET /api/usage/recent?limit=50 — 最近 N 笔
  app.get('/api/usage/recent', async (req) => {
    const q = (req.query && typeof req.query === 'object' ? req.query : {}) as { limit?: unknown };
    const limit = Number(q.limit);
    return { recent: usageService.recent(Number.isFinite(limit) ? limit : 50) };
  });
}
