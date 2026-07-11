/**
 * routes/tags.ts — 客户标签 API(session 认证,全局 auth hook 已保证 req.user 存在)。
 * 标签定义(建/改/删)仅限管理角色;给客户贴标签任何登入者皆可。
 * - GET    /api/tags                        列出所有标签(任何登入者)
 * - POST   /api/tags {name,color}           建标签(仅管理;同名回既有)
 * - PUT    /api/tags/:id {name?,color?}     改标签(仅管理)
 * - DELETE /api/tags/:id                    删标签+连带关联(仅管理)
 * - GET    /api/customers/:chatId/tags      取某客户标签(任何登入者)
 * - PUT    /api/customers/:chatId/tags {tagIds:[]}  整批覆盖某客户标签(任何登入者)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as tagService from '../services/tagService.js';

// 仅管理:通过回 actor,否则已 send 403 并回 null(呼叫方需 return)
function requireAdmin(req: FastifyRequest, reply: FastifyReply): tagService.TagActor | null {
  const user = req.user;
  if (!user) {
    reply.code(401).send({ error: '未登入' });
    return null;
  }
  if (user.role !== '管理') {
    reply.code(403).send({ error: '僅限管理角色' });
    return null;
  }
  return { userId: user.id, userName: user.displayName };
}

function actorOf(req: FastifyRequest): tagService.TagActor {
  const user = req.user;
  return { userId: user?.id ?? null, userName: user?.displayName ?? null };
}

function parseId(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export default async function tagsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/tags — 所有标签
  app.get('/api/tags', async () => ({ tags: tagService.listTags() }));

  // POST /api/tags {name,color} — 建标签(仅管理);同名回既有(200)
  app.post('/api/tags', async (req, reply) => {
    const actor = requireAdmin(req, reply);
    if (!actor) return;
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      name?: unknown;
      color?: unknown;
    };
    const res = tagService.createTag(body.name, body.color, actor);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    return { ok: true, tag: res.tag };
  });

  // PUT /api/tags/:id {name?,color?} — 改标签(仅管理)
  app.put('/api/tags/:id', async (req, reply) => {
    const actor = requireAdmin(req, reply);
    if (!actor) return;
    const id = parseId((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: 'id 不合法' });
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      name?: unknown;
      color?: unknown;
    };
    const res = tagService.updateTag(id, body, actor);
    if (!res.ok) return reply.code(res.notFound ? 404 : 400).send({ error: res.error });
    return { ok: true, tag: res.tag };
  });

  // DELETE /api/tags/:id — 删标签+连带 customer_tags(仅管理)
  app.delete('/api/tags/:id', async (req, reply) => {
    const actor = requireAdmin(req, reply);
    if (!actor) return;
    const id = parseId((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: 'id 不合法' });
    const res = tagService.deleteTag(id, actor);
    if (!res.ok) return reply.code(res.notFound ? 404 : 400).send({ error: res.error });
    return { ok: true };
  });

  // GET /api/customers/:chatId/tags — 某客户标签
  app.get('/api/customers/:chatId/tags', async (req, reply) => {
    const chatId = ((req.params as { chatId: string }).chatId ?? '').trim();
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    return { tags: tagService.getCustomerTags(chatId) };
  });

  // PUT /api/customers/:chatId/tags {tagIds:[]} — 整批覆盖(任何登入者)
  app.put('/api/customers/:chatId/tags', async (req, reply) => {
    const chatId = ((req.params as { chatId: string }).chatId ?? '').trim();
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { tagIds?: unknown };
    const tags = tagService.setCustomerTags(chatId, body.tagIds, actorOf(req));
    return { ok: true, tags };
  });
}
