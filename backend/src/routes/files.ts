/**
 * routes/files.ts — 档案下载:回原档,Content-Disposition 带原文件名(UTF-8)。
 * ?inline=1 → Content-Disposition inline(供图片/PDF 分页预览);默认仍 attachment。
 */
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import * as fileService from '../services/fileService.js';

// 允许以 inline(浏览器内嵌渲染)方式呈现的安全 MIME 白名单。
// 绝不 inline svg/html —— row.mimeType 来自客户端上传字段(可被攻击者控制),
// image/svg+xml 或 text/html inline 打开会在本站同源执行内嵌 <script>(储存型 XSS)。
const INLINE_SAFE_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** 取 MIME 主型别(去掉 ;charset= 等参数并小写) */
function baseMime(mime: string | null | undefined): string {
  return String(mime ?? '').split(';')[0].trim().toLowerCase();
}

export default async function filesRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/files/:id/download?inline=1
  // 授权模型(按设计):凡通过全局 session 认证的内部同仁皆可读取任一客户的档案
  // (系统定位为内部小团队协作,所有客户对所有同仁可见)。此处刻意不做 per-chat 绑定;
  // id 可枚举,但仅登入同仁可达。若未来要收紧,应在此校验 row.lineChatId 的可见性。
  app.get('/api/files/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    const fileId = Number(id);
    if (!Number.isInteger(fileId) || fileId <= 0) {
      return reply.code(400).send({ error: '无效的档案 id' });
    }
    const row = fileService.getFileById(fileId);
    if (!row) return reply.code(404).send({ error: '档案不存在' });
    if (!fs.existsSync(row.localPath)) {
      return reply.code(410).send({ error: '档案实体已遗失(localPath 不存在)' });
    }

    const originalName = row.fileName || `file_${row.id}`;
    // RFC 5987:filename* 支持 UTF-8 原名;filename 为 ASCII 兜底
    const asciiFallback = originalName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    // RFC 5987 attr-char 不含 '()*,encodeURIComponent 不编码它们,需补编
    const encoded = encodeURIComponent(originalName).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

    // ?inline=1(或 true)→ 浏览器内嵌预览(图片/PDF 分页);默认下载。
    // 注意:不再接受空值 '' —— 空值会把任意 ?inline 都当成 inline,徒增攻击面。
    const q = req.query as { inline?: unknown };
    const inlineRaw = Array.isArray(q.inline) ? q.inline[0] : q.inline;
    const inlineRequested = inlineRaw === '1' || inlineRaw === 'true';

    // 只有请求 inline 且 mimeType 属安全白名单时才真的 inline;其余一律 attachment 下载。
    // inline 时用白名单里的真实型别;attachment 时强制 application/octet-stream,
    // 绝不用「储存的、可被攻击者控制的」mimeType 让浏览器 inline 渲染 svg/html。
    const mime = baseMime(row.mimeType);
    const inlineSafe = inlineRequested && INLINE_SAFE_TYPES.has(mime);
    const disposition = inlineSafe ? 'inline' : 'attachment';
    const contentType = inlineSafe ? mime : 'application/octet-stream';

    // 硬化头:即使某处误判,也阻止脚本执行与 MIME 嗅探
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('Content-Type', contentType);
    reply.header(
      'Content-Disposition',
      `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
    );
    const size = fs.statSync(row.localPath).size;
    reply.header('Content-Length', String(size));
    return reply.send(fs.createReadStream(row.localPath));
  });
}
