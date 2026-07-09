/**
 * routes/ingest.ts — 采集写入 API(extension → backend)。
 * 对缺字段/多字段容错:不崩,400 带 error。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { STORAGE_TMP_DIR } from '../db.js';
import { MAX_FILE_SIZE } from '../config.js';
import * as chatService from '../services/chatService.js';
import * as fileService from '../services/fileService.js';
import { getProvider } from '../llm/index.js';
import { summarizeChat } from '../services/summaryService.js';
import { acquireSummarize, releaseSummarize } from '../services/summarizeGuard.js';

export default async function ingestRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/ingest/chats
  app.post('/api/ingest/chats', async (req, reply) => {
    const body = (req.body ?? {}) as { chats?: unknown };
    if (!Array.isArray(body.chats)) {
      return reply.code(400).send({ error: '缺少 chats 数组' });
    }
    const { syncStates } = chatService.upsertChats(body.chats as chatService.IngestChat[]);
    return { ok: true, syncStates };
  });

  // POST /api/ingest/messages(可带 oldestReachedTs / backfillDone,按需建档翻历史时用)
  app.post('/api/ingest/messages', async (req, reply) => {
    const body = (req.body ?? {}) as {
      chatId?: unknown;
      messages?: unknown;
      oldestReachedTs?: unknown;
      backfillDone?: unknown;
    };
    const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    if (!Array.isArray(body.messages)) return reply.code(400).send({ error: '缺少 messages 数组' });
    const oldestReachedTs = Number(body.oldestReachedTs);
    const { inserted, missingFiles } = chatService.insertMessages(
      chatId,
      body.messages as chatService.IngestMessage[],
      {
        oldestReachedTs: Number.isFinite(oldestReachedTs) ? oldestReachedTs : undefined,
        backfillDone: body.backfillDone === true || body.backfillDone === 1 || body.backfillDone === '1',
      }
    );
    return { ok: true, inserted, missingFiles };
  });

  // GET /api/ingest/missing-files?limit=200&chatId= — 缺档权威兜底清单
  app.get('/api/ingest/missing-files', async (req) => {
    const q = (req.query ?? {}) as { limit?: string; chatId?: string };
    return {
      files: fileService.listMissingFiles({
        limit: q.limit !== undefined ? Number(q.limit) : undefined,
        chatId: q.chatId,
      }),
    };
  });

  // GET /api/ingest/sync-requests — 待建档请求(extension 轮询)
  app.get('/api/ingest/sync-requests', async () => ({
    requests: chatService.listPendingSyncRequests(),
  }));

  // POST /api/ingest/sync-requests/:chatId/done — extension 回报建档结果
  app.post('/api/ingest/sync-requests/:chatId/done', async (req, reply) => {
    const { chatId: rawChatId } = req.params as { chatId: string };
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    const body = (req.body ?? {}) as { ok?: unknown; error?: unknown };
    const ok = body.ok === true;
    const { completed } = chatService.completeSyncRequest(
      chatId,
      ok,
      typeof body.error === 'string' ? body.error : undefined
    );
    // 建档成功且 LLM 已配置 → 异步触发总结(不阻塞回应;失败只记日志)。
    // 必须带 force:建档回填的是「更旧」的历史消息,MAX(timestamp) 不变,
    // 若此前已有覆盖到最新消息的 summary,缓存分支会直接返回 cached、完全不调 LLM,
    // 完整历史就永远不会被总结。建档成功的语义即「基于完整历史重新总结」。
    if (completed && getProvider()) {
      const log = req.log;
      // 跨路径互斥:与 webui「重新生成總結」共用同一把锁,避免同 chat 并发双总结各插一行。
      // 取不到锁 = 已有总结在跑,跳过本次自动总结(该次总结已覆盖最新历史)。
      if (acquireSummarize(chatId)) {
        setImmediate(() => {
          summarizeChat(chatId, { force: true, actor: { userId: null, userName: '系統(建檔)' } })
            .then((r) => {
              if (!r.ok) log.warn({ chatId, error: r.error }, '建檔後自動總結未執行');
            })
            .catch((err) => log.error({ err, chatId }, '建檔後自動總結失敗'))
            .finally(() => releaseSummarize(chatId));
        });
      } else {
        log.info({ chatId }, '建檔後自動總結跳過:該客戶已有總結進行中');
      }
    }
    return { ok: true };
  });

  // POST /api/ingest/notes
  app.post('/api/ingest/notes', async (req, reply) => {
    const body = (req.body ?? {}) as { chatId?: unknown; notes?: unknown };
    const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
    if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
    if (!Array.isArray(body.notes)) return reply.code(400).send({ error: '缺少 notes 数组' });
    const { upserted } = chatService.upsertNotes(chatId, body.notes as chatService.IngestNote[]);
    return { ok: true, upserted };
  });

  // POST /api/ingest/file — multipart/form-data(流式处理,档案不进内存)
  // fields: chatId, lineMessageId, contentHash, fileName, fileSize, expiredAt, mimeType + file 二进制
  app.post('/api/ingest/file', async (req, reply) => {
    if (!req.isMultipart()) {
      return reply.code(400).send({ error: '必须为 multipart/form-data' });
    }
    const fields: Record<string, string> = {};
    let tmpPath: string | null = null;
    let fileBytes = 0;
    let truncated = false;
    try {
      // 逐 part 消费:file 流式 pipeline 到临时档,其余字段收成字符串
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (tmpPath !== null) {
            // 只接受第一个 file part,其余排空丢弃
            part.file.resume();
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
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
      }

      const chatId = typeof fields.chatId === 'string' ? fields.chatId.trim() : '';
      const contentHash = typeof fields.contentHash === 'string' ? fields.contentHash.trim() : '';
      if (!chatId) return reply.code(400).send({ error: '缺少 chatId' });
      if (!contentHash) return reply.code(400).send({ error: '缺少 contentHash' });
      if (!tmpPath || fileBytes === 0) return reply.code(400).send({ error: '缺少 file 二进制内容' });
      if (truncated) {
        return reply.code(413).send({ error: `档案超过大小上限(${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB)` });
      }

      const { fileId } = fileService.saveIngestFile({
        chatId,
        lineMessageId: fields.lineMessageId,
        contentHash,
        fileName: fields.fileName,
        fileSize: fields.fileSize !== undefined ? Number(fields.fileSize) : undefined,
        expiredAt: fields.expiredAt !== undefined ? Number(fields.expiredAt) : undefined,
        mimeType: fields.mimeType,
        tmpPath,
        fileBytes,
      });
      return { ok: true, fileId };
    } finally {
      // 临时档若未被 saveIngestFile 消费(rename/删除),这里兜底清理
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
