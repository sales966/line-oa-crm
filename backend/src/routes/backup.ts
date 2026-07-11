/**
 * routes/backup.ts — 备份档管理 API(session 认证;仅「管理」角色,非管理一律 403)。
 * 全局 auth hook 已保证 req.user 存在;此处再收紧到管理角色。
 *  - GET  /api/backup/list            列出备份 → {backups:[{name,sizeBytes,createdAt}]}
 *  - POST /api/backup/run             立即手动备份 → {ok,backup} 或 500;记 audit(backup_run)
 *  - GET  /api/backup/download/:name  下载指定备份档(attachment;防穿越;找不到 404)
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as backupService from '../services/backupService.js';
import { recordAudit, type AuditActor } from '../services/auditService.js';

// 仅管理:通过回 actor,否则已 send 401/403 并回 null(呼叫方需 return)
function requireAdmin(req: FastifyRequest, reply: FastifyReply): AuditActor | null {
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

export default async function backupRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/backup/list — 列出所有备份(仅管理)
  app.get('/api/backup/list', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { backups: backupService.listBackups() };
  });

  // POST /api/backup/run — 立即手动备份(仅管理)
  app.post('/api/backup/run', async (req, reply) => {
    const actor = requireAdmin(req, reply);
    if (!actor) return;
    try {
      const backup = await backupService.runBackup('manual');
      recordAudit(null, actor, 'backup_run', backup.name, {
        sizeBytes: backup.sizeBytes,
      });
      return { ok: true, backup };
    } catch (err) {
      app.log.error({ err }, '[backup] 手动备份失败');
      return reply.code(500).send({ ok: false, error: '备份失败' });
    }
  });

  // GET /api/backup/download/:name — 下载指定备份档(仅管理;防穿越;找不到 404)
  app.get('/api/backup/download/:name', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { name } = req.params as { name: string };
    const full = backupService.resolveBackupPath(name);
    if (!full) return reply.code(404).send({ error: '备份档不存在' });

    // name 已过 resolveBackupPath 校验(纯 ASCII 的 app-YYYYMMDD-HHmmss.sqlite),可直接用
    const safeName = path.basename(full);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
    reply.header('Content-Length', String(fs.statSync(full).size));
    return reply.send(fs.createReadStream(full));
  });
}
