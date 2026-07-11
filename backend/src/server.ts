/**
 * server.ts — Fastify 入口。
 * - CORS 仅放行 https://chat.line.biz(extension content script 的同步来源;
 *   webui 由 backend 同源服务,不需要 CORS)
 * - @fastify/static 服务 ../webui(目录不存在时跳过,不崩)
 * - 监听 0.0.0.0:4680(env PORT 可覆盖)
 */
import 'dotenv/config';
import fs from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';

import { VERSION, PORT, BODY_LIMIT, MAX_FILE_SIZE } from './config.js';
import { WEBUI_DIR } from './db.js';
import { counts } from './services/chatService.js';
import { seedAdminIfEmpty } from './services/authService.js';
import { llmStatus } from './llm/index.js';
import { authOnRequest } from './authHook.js';
import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import ingestRoutes from './routes/ingest.js';
import readRoutes from './routes/read.js';
import filesRoutes from './routes/files.js';
import summarizeRoutes from './routes/summarize.js';
import summarizeStreamRoutes from './routes/summarizeStream.js';
import progressRoutes from './routes/progress.js';
import summaryEditRoutes from './routes/summaryEdit.js';
import auditRoutes from './routes/audit.js';
import uploadsRoutes from './routes/uploads.js';
import mentionsRoutes from './routes/mentions.js';
import issuesRoutes from './routes/issues.js';
import docRoleRoutes from './routes/docrole.js';
import dashboardRoutes from './routes/dashboard.js';
import orderRoutes from './routes/orders.js';
import qrRoutes from './routes/qr.js';
import batchRoutes from './routes/batch.js';
import usageRoutes from './routes/usage.js';
import adminHealthRoutes from './routes/admin-health.js';
import tagsRoutes from './routes/tags.js';
import searchRoutes from './routes/search.js';
import exportRoutes from './routes/export.js';
import backupRoutes from './routes/backup.js';
import * as backupService from './services/backupService.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: BODY_LIMIT, // JSON body 上限(rawJson 可能较大)
});

// 全局错误容错:未捕获错误回 JSON,不崩进程
app.setErrorHandler((err: unknown, req, reply) => {
  req.log.error(err);
  const e = (err ?? {}) as { statusCode?: unknown; message?: unknown };
  const status = typeof e.statusCode === 'number' && e.statusCode >= 400 ? e.statusCode : 500;
  const message = typeof e.message === 'string' && e.message ? e.message : '服务器内部错误';
  reply.code(status).send({ error: message });
});

async function main(): Promise<void> {
  // CORS:白名单,仅 extension content script 的来源(webui 同源无需 CORS)
  await app.register(cors, {
    origin: ['https://chat.line.biz'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // cookie:session cookie(lineoa_session,httpOnly)解析/写入
  await app.register(cookie);

  // 认证 hook:/api/* 需 session(豁免 login/health/ingest;ingest 走 Extension Token);
  // 静态资源不挡。注册于 cors 之后,preflight 不受影响
  app.addHook('onRequest', authOnRequest);

  // multipart:不用 attachFieldsToBody(避免整档缓冲进内存),
  // /api/ingest/file 以 req.parts() 流式落盘;上限与 extension 一致(契约 300MB)
  await app.register(multipart, {
    limits: { fileSize: MAX_FILE_SIZE, files: 2, fields: 20 },
  });

  // .html(含 / → index.html)回 Cache-Control: no-store:
  // Firefox/Safari 会因此停用该页 bfcache,避免登出后按「返回键」从 bfcache
  // 还原出已登出用户的页面(webui api.js 的 pageshow 重验 session 为主要防线,
  // 此为双保险)。注:不用 @fastify/static 的 setHeaders——它先于插件自身的
  // Cache-Control 写入 raw,会被覆盖;onSend 在最后执行才盖得过去
  app.addHook('onSend', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path === '/' || path.endsWith('.html')) {
      reply.header('cache-control', 'no-store');
    }
    // 区网存取(PNA):Chrome 从 chat.line.biz(公网)对内网后端发请求时,
    // 预检会要求此回应头,否则同步被浏览器挡下(failed to fetch)。无害,一律回。
    reply.header('access-control-allow-private-network', 'true');
  });

  // 静态服务 webui(由另一模块开发,可能尚不存在)
  if (fs.existsSync(WEBUI_DIR) && fs.statSync(WEBUI_DIR).isDirectory()) {
    await app.register(fastifyStatic, { root: WEBUI_DIR, prefix: '/' });
    app.log.info(`webui served from ${WEBUI_DIR}`);
  } else {
    app.log.warn(`webui 目录不存在(${WEBUI_DIR}),仅提供 API;建好后重启即生效`);
    app.get('/', async () => ({
      ok: true,
      message: 'LINE OA 客户进度中枢 backend 运行中;webui 尚未部署',
      api: '/api/health',
    }));
  }

  // GET /api/extension-token — 登入页显示插件 Token(内网 LAN;token 只存 .env)。
  // 公网加固:PUBLIC_MODE=1 时 authHook 已要求 session,未登入者到不了这里(回 401)。
  app.get('/api/extension-token', async () => ({ token: process.env.EXTENSION_TOKEN || '' }));

  // GET /api/health
  app.get('/api/health', async () => ({
    ok: true,
    version: VERSION,
    llm: llmStatus(),
    counts: counts(),
  }));

  await app.register(authRoutes);
  await app.register(usersRoutes);
  await app.register(ingestRoutes);
  await app.register(readRoutes);
  await app.register(filesRoutes);
  await app.register(summarizeRoutes);
  await app.register(summarizeStreamRoutes);
  await app.register(progressRoutes);
  await app.register(summaryEditRoutes);
  await app.register(auditRoutes);
  await app.register(uploadsRoutes);
  await app.register(mentionsRoutes);
  await app.register(issuesRoutes);
  await app.register(docRoleRoutes);
  await app.register(dashboardRoutes);
  await app.register(orderRoutes);
  await app.register(qrRoutes);
  await app.register(batchRoutes);
  await app.register(usageRoutes);
  await app.register(adminHealthRoutes);
  await app.register(tagsRoutes);
  await app.register(searchRoutes);
  await app.register(exportRoutes);
  await app.register(backupRoutes);

  // 种子:users 空表时建 admin/管理,密码取 env ADMIN_INITIAL_PASSWORD(默认 admin123)
  seedAdminIfEmpty((msg) => app.log.warn(msg));

  // ingest 通道认证告警:未设 EXTENSION_TOKEN 时 /api/ingest/* 默认 fail-closed(401)
  if (!process.env.EXTENSION_TOKEN) {
    if (process.env.ALLOW_UNAUTH_INGEST === '1') {
      app.log.warn(
        'EXTENSION_TOKEN 未设定且 ALLOW_UNAUTH_INGEST=1:/api/ingest/* 目前无认证放行(仅供首次引导,请尽快设定 EXTENSION_TOKEN)'
      );
    } else {
      app.log.warn(
        'EXTENSION_TOKEN 未设定:/api/ingest/* 已 fail-closed(全部回 401)。请在 .env 设定 EXTENSION_TOKEN 后重启,插件方能同步'
      );
    }
  }

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`backend listening on http://0.0.0.0:${PORT} (llm=${llmStatus()})`);

  // 启动自动备份排程(启动即备份一次 + 每 BACKUP_INTERVAL_HOURS 小时一次)。
  // 用 try/catch 兜底:排程建立失败绝不可挡服务启动(服务已 listen 成功)。
  try {
    backupService.scheduleBackups();
    app.log.info('[backup] 自动备份排程已启动');
  } catch (err) {
    app.log.error({ err }, '[backup] 自动备份排程启动失败(不影响服务运行)');
  }
}

main().catch((err) => {
  app.log.error(err, 'server 启动失败');
  process.exit(1);
});
