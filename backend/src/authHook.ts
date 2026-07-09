/**
 * authHook.ts — 全站认证 onRequest hook。
 * - /api/* 需有效 session;豁免:/api/auth/login、/api/health、/api/ingest/*
 * - /api/ingest/*(插件用):header X-Extension-Token == env EXTENSION_TOKEN;
 *   env 未设 → 默认 fail-closed(401),除非显式 ALLOW_UNAUTH_INGEST=1(仅首次引导用);
 *   设了必须相符,否则 401
 * - 静态资源(非 /api/)不挡(login.html 自己跳转)
 * - 通过 session 认证时装饰 req.user 供路由用
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as authService from './services/authService.js';
import type { SessionUser } from './services/authService.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export async function authOnRequest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = req.url.split('?')[0];
  if (!path.startsWith('/api/')) return; // 静态资源不挡

  // 插件采集通道:Extension Token。
  // fail-closed:EXTENSION_TOKEN 未设时默认拒绝(否则局域网内任何未认证客户端都能写库/落盘/触发 LLM);
  // 仅当显式 ALLOW_UNAUTH_INGEST=1(首次引导)才放行。设了 token 则必须相符。
  if (path.startsWith('/api/ingest/')) {
    const expected = process.env.EXTENSION_TOKEN;
    if (!expected) {
      if (process.env.ALLOW_UNAUTH_INGEST === '1') return; // 显式开的引导后门
      reply.code(401).send({ error: 'ingest 通道未启用(EXTENSION_TOKEN 未设定)' });
      return;
    }
    if (req.headers['x-extension-token'] !== expected) {
      reply.code(401).send({ error: 'Extension Token 不符' });
    }
    return;
  }

  // 登入页免登入即可读:插件安装用的 Token(内网 LAN 场景;token 只存 .env,不硬编码进原始码)
  if (path === '/api/auth/login' || path === '/api/health' || path === '/api/extension-token') return;

  const user = authService.getSessionUser(req.cookies?.[authService.SESSION_COOKIE]);
  if (!user) {
    reply.code(401).send({ error: '未登入' });
    return;
  }
  req.user = user;
}
