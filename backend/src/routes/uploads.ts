/**
 * routes/uploads.ts — 同事上传档案(session 认证;全局 hook 已挡未登入)。
 * - POST /api/customers/:chatId/files/upload  multipart(field: file 二进制)
 *   → 存 storage/files/{chatId}/upload-{rand}_{fileName};files 行 source='upload'、
 *     uploaderUserId/uploaderName=登入者;记 file_upload 审计;回 {ok:true,file}
 * 流式落盘(不整档进内存);上限同 MAX_FILE_SIZE(契约 300MB)。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { STORAGE_TMP_DIR } from '../db.js';
import { MAX_FILE_SIZE } from '../config.js';
import * as fileService from '../services/fileService.js';

export default async function uploadsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/customers/:chatId/files/upload', async (req, reply) => {
    const { chatId: rawChatId } = req.params as { chatId: string };
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    const user = req.user;
    if (!user) return reply.code(401).send({ error: '未登入' }); // 全局 hook 已挡,此处防御
    if (!req.isMultipart()) return reply.code(400).send({ error: '必须为 multipart/form-data' });

    let tmpPath: string | null = null;
    let fileBytes = 0;
    let truncated = false;
    let fileName = '';
    let mimeType = '';
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (tmpPath !== null) {
            part.file.resume(); // 只接受第一个 file part,其余排空丢弃
            continue;
          }
          const p = path.join(
            STORAGE_TMP_DIR,
            `upload_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`
          );
          await pipeline(part.file, fs.createWriteStream(p));
          tmpPath = p;
          truncated = part.file.truncated === true;
          fileBytes = fs.statSync(p).size;
          fileName = typeof part.filename === 'string' ? part.filename : '';
          mimeType = typeof part.mimetype === 'string' ? part.mimetype : '';
        }
        // 其余字段忽略(上传只需 file 二进制)
      }

      if (!tmpPath || fileBytes === 0) return reply.code(400).send({ error: '缺少 file 二进制内容' });
      if (truncated) {
        return reply
          .code(413)
          .send({ error: `档案超过大小上限(${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB)` });
      }

      const { file } = fileService.saveUploadedFile({
        chatId,
        fileName,
        mimeType,
        tmpPath,
        fileBytes,
        uploader: { userId: user.id, userName: user.displayName },
      });
      tmpPath = null; // 已被 saveUploadedFile 的 rename 消费,勿在 finally 删
      return { ok: true, file };
    } finally {
      if (tmpPath && fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          /* 清理失败不影响响应 */
        }
      }
    }
  });
}
