/**
 * routes/users.ts — 使用者管理 API(仅 role=管理)。
 * 全局 auth hook 已保证 session 有效并装饰 req.user;此处再加角色门槛。
 */
import type { FastifyInstance } from 'fastify';
import * as authService from '../services/authService.js';

export default async function usersRoutes(app: FastifyInstance): Promise<void> {
  // 本 plugin 内所有路由:仅限管理(fastify 封装作用域,不影响其他路由)
  app.addHook('onRequest', async (req, reply) => {
    if (!req.user || req.user.role !== '管理') {
      reply.code(403).send({ error: '僅限管理角色' });
    }
  });

  // GET /api/users
  app.get('/api/users', async () => ({ users: authService.listUsers() }));

  // POST /api/users — 建帐号:username/displayName/role/初始密码;username 冲突 400
  app.post('/api/users', async (req, reply) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      username?: unknown;
      displayName?: unknown;
      role?: unknown;
      password?: unknown;
    };
    const res = authService.createUser(body);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    return { ok: true, user: res.user };
  });

  // PUT /api/users/:id — 改 displayName/role/active/重设密码;不可停用/降级自己
  app.put('/api/users/:id', async (req, reply) => {
    const { id: rawId } = req.params as { id: string };
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'id 不合法' });
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      displayName?: unknown;
      role?: unknown;
      active?: unknown;
      password?: unknown;
    };
    const res = authService.updateUser(id, body, req.user!.id);
    if (!res.ok) return reply.code(res.notFound ? 404 : 400).send({ error: res.error });
    return { ok: true, user: res.user };
  });
}
