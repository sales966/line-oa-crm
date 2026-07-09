/**
 * routes/auth.ts — 登入/登出/本人资讯/改密码 + 使用者管理(仅 role=管理)。
 * 帐密错一律 401 且不泄漏原因;同 IP 连续失败 5 次锁 60 秒(authService 内存 Map),
 * 锁定中回 429 + 明确锁定提示(锁按 IP 计,不泄漏帐号是否存在)。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import * as authService from '../services/authService.js';

/** 登入节流锁定提示(锁按 IP 计,不泄漏帐号是否存在) */
const LOCKED_MSG = '登入失敗次數過多,帳號已暫時鎖定,請 1 分鐘後再試';

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(authService.SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: Math.floor(authService.SESSION_TTL_MS / 1000), // 秒
  });
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/auth/login(hook 豁免;帐密错一律 401 不区分原因;锁定中 429 + 锁定提示)
  app.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip || 'unknown';
    if (authService.isLoginLocked(ip)) {
      return reply.code(429).send({ error: LOCKED_MSG });
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      username?: unknown;
      password?: unknown;
    };
    const user = authService.verifyLogin(body.username, body.password);
    if (!user) {
      authService.noteLoginFailure(ip);
      if (authService.isLoginLocked(ip)) {
        // 本次失败恰好触发锁定:直接回锁定提示,让使用者知道再试也没用
        return reply.code(429).send({ error: LOCKED_MSG });
      }
      return reply.code(401).send({ error: '帳號或密碼錯誤' });
    }
    authService.noteLoginSuccess(ip);
    const { token } = authService.createSession(user.id);
    setSessionCookie(reply, token);
    return { ok: true, user };
  });

  // POST /api/auth/logout — 删 session + 清 cookie
  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[authService.SESSION_COOKIE];
    if (token) authService.destroySession(token);
    reply.clearCookie(authService.SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // GET /api/auth/me — hook 已验证 session 并装饰 req.user
  app.get('/api/auth/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: '未登入' });
    return { user: req.user };
  });

  // PUT /api/auth/password — 本人改密码
  app.put('/api/auth/password', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: '未登入' });
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      oldPassword?: unknown;
      newPassword?: unknown;
    };
    const res = authService.changePassword(req.user.id, body.oldPassword, body.newPassword);
    if (!res.ok) return reply.code(res.unauthorized ? 401 : 400).send({ error: res.error });
    return { ok: true };
  });
}
