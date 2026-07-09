/**
 * routes/issues.ts — 问题回报(session 认证;全局 auth hook 已装饰 req.user)。
 * - POST /api/issues            {title, body, lineChatId?}  → 以 req.user 记 reporter
 * - GET  /api/issues                                        → 管理員全部;非管理員只看自己
 * - PUT  /api/issues/:id        {status?, adminNote?}       → 仅管理員(非管理員 403)
 * - GET  /api/issues/open-count                             → 管理員未处理数(仅管理員)
 */
import type { FastifyInstance } from 'fastify';
import * as issueService from '../services/issueService.js';

export default async function issuesRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/issues — 任何登入者回报
  app.post('/api/issues', async (req, reply) => {
    const user = req.user;
    if (!user) return reply.code(401).send({ error: '未登入' });
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      title?: unknown;
      body?: unknown;
      lineChatId?: unknown;
    };
    const res = issueService.createIssue(user, body);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    return { ok: true, issue: res.issue };
  });

  // GET /api/issues — 管理員全部;非管理員只看自己
  app.get('/api/issues', async (req, reply) => {
    const user = req.user;
    if (!user) return reply.code(401).send({ error: '未登入' });
    return { issues: issueService.listIssues(user) };
  });

  // GET /api/issues/open-count — 管理員未处理数(仅管理員)
  app.get('/api/issues/open-count', async (req, reply) => {
    const user = req.user;
    if (!user) return reply.code(401).send({ error: '未登入' });
    if (user.role !== '管理') return reply.code(403).send({ error: '僅限管理角色' });
    return { count: issueService.countOpen() };
  });

  // PUT /api/issues/:id — 仅管理員改 status/adminNote(非管理員 403)
  app.put('/api/issues/:id', async (req, reply) => {
    const user = req.user;
    if (!user) return reply.code(401).send({ error: '未登入' });
    const { id: rawId } = req.params as { id: string };
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'id 不合法' });
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      status?: unknown;
      adminNote?: unknown;
    };
    const res = issueService.updateIssue(id, body, user);
    if (!res.ok) {
      const code = res.forbidden ? 403 : res.notFound ? 404 : 400;
      return reply.code(code).send({ error: res.error });
    }
    return { ok: true, issue: res.issue };
  });
}
