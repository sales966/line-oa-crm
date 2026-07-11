/**
 * routes/search.ts — 全局搜寻(session 认证,全局 auth hook 已保证 req.user 存在)。
 * GET /api/search?q=<关键字>&limit=30
 *   → {results:[{lineChatId, customerName, matchType, snippet, timestamp}]}
 * q 须 trim 后非空且长度 < 100,否则回空结果;limit 夹在 1..30(默认 30)。
 */
import type { FastifyInstance } from 'fastify';
import * as searchService from '../services/searchService.js';

const MAX_LIMIT = 30;

export default async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/search', async (req) => {
    const { q: rawQ, limit: rawLimit } = req.query as { q?: string; limit?: string };
    const q = typeof rawQ === 'string' ? rawQ.trim() : '';
    if (!q || q.length >= 100) return { results: [] };

    const n = Number(rawLimit);
    const limit = Number.isFinite(n)
      ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)))
      : MAX_LIMIT;

    return { results: searchService.search(q, limit) };
  });
}
