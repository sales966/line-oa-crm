/**
 * fileService.ts — 档案落地与查询。
 * 存储路径:storage/files/{chatId}/{contentHash}_{sanitizedFileName};下载回原名。
 * 上传由 routes/ingest.ts 流式写入临时档后交给 saveIngestFile rename 落地。
 * 防覆盖:同 contentHash 且实体档完好时跳过写盘,不允许静默替换已存档内容。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import db, { STORAGE_FILES_DIR } from '../db.js';
import { MAX_FILENAME_LEN, MAX_FULL_PATH_LEN } from '../config.js';
import { recordAudit } from './auditService.js';

export interface FileRow {
  id: number;
  lineChatId: string;
  lineMessageId: string | null;
  fileName: string | null;
  fileSize: number | null;
  contentHash: string;
  localPath: string;
  mimeType: string | null;
  uploadedAt: number | null;
  downloadedAt: number | null;
  expiredAt: number | null;
  source?: string | null;
  uploaderUserId?: number | null;
  uploaderName?: string | null;
}

/** 按 UTF-16 code unit 上限截断,但不切断代理对(emoji 等) */
function truncateNoSplit(s: string, maxUnits: number): string {
  if (s.length <= maxUnits) return s;
  let out = '';
  for (const ch of s) {
    // for...of 按码点迭代;ch.length 为 1 或 2(代理对)
    if (out.length + ch.length > maxUnits) break;
    out += ch;
  }
  return out;
}

/** 保留原名,仅移除路径非法字符与控制字符;防止路径穿越 */
export function sanitizeFileName(name: unknown): string {
  let s = String(name ?? '').trim();
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
  s = s.replace(/^\.+/, '_'); // 不允许以 . 开头(隐藏档/..)
  if (!s) s = 'file';
  s = truncateNoSplit(s, MAX_FILENAME_LEN); // 长度保护(码点安全)
  return s;
}

/** chatId 用作目录名,同样消毒 */
function sanitizeDirName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const s = String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_');
  return s || '_';
}

/**
 * 按完整路径预算(Windows MAX_PATH)对档名做二次收紧:
 * 超出额度时优先保留扩展名截断主干;额度太小则退化为纯扩展名(前缀已含 contentHash 可区分)。
 */
function fitFileNameToPath(dir: string, prefix: string, safeName: string): string {
  const budget = MAX_FULL_PATH_LEN - dir.length - 1 /* path sep */ - prefix.length;
  if (safeName.length <= budget) return safeName;
  const ext = truncateNoSplit(path.extname(safeName), 20);
  if (budget >= ext.length + 1) {
    const stem = safeName.slice(0, safeName.length - ext.length);
    return truncateNoSplit(stem, budget - ext.length) + ext;
  }
  // 极端情况:额度连扩展名都放不下,尽量保留能放的部分
  return truncateNoSplit(ext || safeName, Math.max(budget, 1));
}

const toInt = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const upsertFileStmt = db.prepare(`
  INSERT INTO files (lineChatId, lineMessageId, fileName, fileSize, contentHash, localPath, mimeType, uploadedAt, downloadedAt, expiredAt)
  VALUES (@lineChatId, @lineMessageId, @fileName, @fileSize, @contentHash, @localPath, @mimeType, @uploadedAt, @downloadedAt, @expiredAt)
  ON CONFLICT(contentHash) DO UPDATE SET
    lineMessageId = COALESCE(excluded.lineMessageId, files.lineMessageId),
    fileName = COALESCE(excluded.fileName, files.fileName),
    fileSize = COALESCE(excluded.fileSize, files.fileSize),
    localPath = excluded.localPath,
    mimeType = COALESCE(excluded.mimeType, files.mimeType),
    uploadedAt = COALESCE(files.uploadedAt, excluded.uploadedAt),
    downloadedAt = excluded.downloadedAt,
    expiredAt = COALESCE(excluded.expiredAt, files.expiredAt)
`);

/** 实体完好时仅补齐 metadata,绝不动 localPath / 磁盘内容 */
const updateFileMetaStmt = db.prepare(`
  UPDATE files SET
    lineMessageId = COALESCE(@lineMessageId, lineMessageId),
    fileName = COALESCE(@fileName, fileName),
    fileSize = COALESCE(@fileSize, fileSize),
    mimeType = COALESCE(@mimeType, mimeType),
    expiredAt = COALESCE(@expiredAt, expiredAt),
    downloadedAt = @now
  WHERE contentHash = @contentHash
`);

const fileByHashStmt = db.prepare('SELECT * FROM files WHERE contentHash = ?');

export interface SaveFileInput {
  chatId: string;
  lineMessageId?: string;
  contentHash: string;
  fileName?: string;
  fileSize?: number;
  expiredAt?: number;
  mimeType?: string;
  uploadedAt?: number;
  /** 已流式落地的临时档路径(本函数负责 rename 或删除) */
  tmpPath: string;
  /** 临时档实际字节数 */
  fileBytes: number;
}

/**
 * 落地档案 + upsert files 表;返回 fileId。
 * 同 contentHash 且实体档完好时跳过写盘(防止用已知 contentHash 静默替换已存档案),
 * 仅补齐缺失的 metadata;实体遗失时才允许重新落地修复。
 */
export function saveIngestFile(input: SaveFileInput): { fileId: number } {
  const now = Date.now();

  const existing = fileByHashStmt.get(input.contentHash) as FileRow | undefined;
  if (existing && fs.existsSync(existing.localPath)) {
    // 已有完好实体:不覆盖,不改 localPath,丢弃本次上传内容
    fs.unlinkSync(input.tmpPath);
    updateFileMetaStmt.run({
      contentHash: input.contentHash,
      lineMessageId: input.lineMessageId ?? null,
      fileName: typeof input.fileName === 'string' && input.fileName ? input.fileName : null,
      fileSize: toInt(input.fileSize),
      mimeType: typeof input.mimeType === 'string' && input.mimeType ? input.mimeType : null,
      expiredAt: toInt(input.expiredAt),
      now,
    });
    return { fileId: existing.id };
  }

  const dir = path.join(STORAGE_FILES_DIR, sanitizeDirName(input.chatId));
  fs.mkdirSync(dir, { recursive: true });
  const prefix = `${sanitizeDirName(input.contentHash)}_`;
  const safeName = fitFileNameToPath(dir, prefix, sanitizeFileName(input.fileName ?? input.contentHash));
  const localPath = path.join(dir, `${prefix}${safeName}`);
  // 临时档与 storage/files 同卷,rename 不复制内容、不阻塞事件循环大段时间
  fs.renameSync(input.tmpPath, localPath);

  upsertFileStmt.run({
    lineChatId: input.chatId,
    lineMessageId: input.lineMessageId ?? null,
    fileName: typeof input.fileName === 'string' && input.fileName ? input.fileName : safeName,
    fileSize: toInt(input.fileSize) ?? input.fileBytes,
    contentHash: input.contentHash,
    localPath,
    mimeType: typeof input.mimeType === 'string' && input.mimeType ? input.mimeType : null,
    // 契约的 multipart 字段没有 uploadedAt:未提供时以落地时间兜底,避免永远为 NULL
    uploadedAt: toInt(input.uploadedAt) ?? now,
    downloadedAt: now,
    expiredAt: toInt(input.expiredAt),
  });
  const row = fileByHashStmt.get(input.contentHash) as FileRow;
  return { fileId: row.id };
}

const listFilesStmt = db.prepare(
  'SELECT * FROM files WHERE lineChatId = ? ORDER BY COALESCE(uploadedAt, downloadedAt) DESC, id DESC'
);
const fileByIdStmt = db.prepare('SELECT * FROM files WHERE id = ?');

export function listFiles(chatId: string) {
  const rows = listFilesStmt.all(chatId) as FileRow[];
  return rows.map((r) => ({ ...r, downloadUrl: `/api/files/${r.id}/download` }));
}

export function getFileById(id: number): FileRow | null {
  const row = fileByIdStmt.get(id) as FileRow | undefined;
  return row ?? null;
}

// ---------- 同事上传档案(source='upload') ----------

const insertUploadFileStmt = db.prepare(`
  INSERT INTO files (lineChatId, lineMessageId, fileName, fileSize, contentHash, localPath, mimeType,
                     uploadedAt, downloadedAt, expiredAt, source, uploaderUserId, uploaderName)
  VALUES (@lineChatId, NULL, @fileName, @fileSize, @contentHash, @localPath, @mimeType,
          @uploadedAt, @uploadedAt, NULL, 'upload', @uploaderUserId, @uploaderName)
`);

export interface SaveUploadInput {
  chatId: string;
  fileName?: string;
  mimeType?: string;
  /** 已流式落地的临时档路径(本函数负责 rename) */
  tmpPath: string;
  fileBytes: number;
  uploader: { userId: number | null; userName: string | null };
}

/**
 * 落地同事上传的档案:source='upload',contentHash='upload-'+随机(无 LINE hash),
 * 记 uploaderUserId/uploaderName,并写 file_upload 审计。返回含 downloadUrl 的档案行。
 */
export function saveUploadedFile(input: SaveUploadInput): { file: FileRow & { downloadUrl: string } } {
  const now = Date.now();
  const contentHash = 'upload-' + crypto.randomUUID();
  const dir = path.join(STORAGE_FILES_DIR, sanitizeDirName(input.chatId));
  fs.mkdirSync(dir, { recursive: true });
  const prefix = `${contentHash}_`;
  const safeName = fitFileNameToPath(dir, prefix, sanitizeFileName(input.fileName ?? 'file'));
  const localPath = path.join(dir, `${prefix}${safeName}`);
  fs.renameSync(input.tmpPath, localPath);

  const info = insertUploadFileStmt.run({
    lineChatId: input.chatId,
    fileName: typeof input.fileName === 'string' && input.fileName ? input.fileName : safeName,
    fileSize: input.fileBytes,
    contentHash,
    localPath,
    mimeType: typeof input.mimeType === 'string' && input.mimeType ? input.mimeType : null,
    uploadedAt: now,
    uploaderUserId: input.uploader.userId,
    uploaderName: input.uploader.userName,
  });
  const id = Number(info.lastInsertRowid);
  recordAudit(input.chatId, { userId: input.uploader.userId, userName: input.uploader.userName }, 'file_upload', String(id), {
    fileName: safeName,
    fileSize: input.fileBytes,
    source: 'upload',
  });
  const row = fileByIdStmt.get(id) as FileRow;
  return { file: { ...row, downloadUrl: `/api/files/${id}/download` } };
}

// ---------- 缺档兜底清单(missing-files) ----------

export interface MissingFileEntry {
  chatId: string;
  contentHash: string;
  fileName: string | null;
  lineMessageId: string | null;
  fileSize: number | null;
  expiredAt: number | null;
}

/**
 * messages 引用了 contentHash 但 files 无实体、且未过期(expiredAt 为空或 > now)的清单。
 * 按 expiredAt 升序(最急的在前,无期限的在后);同 contentHash 去重。
 */
const MISSING_FILES_SELECT = `
  SELECT m.lineChatId AS chatId, m.contentHash, m.fileName, m.lineMessageId, m.fileSize, m.expiredAt
  FROM messages m
  LEFT JOIN files f ON f.contentHash = m.contentHash
  WHERE m.contentHash IS NOT NULL AND f.id IS NULL
    AND (m.expiredAt IS NULL OR m.expiredAt > @now)`;

const MISSING_FILES_TAIL = `
  GROUP BY m.contentHash
  ORDER BY (m.expiredAt IS NULL) ASC, m.expiredAt ASC
  LIMIT @limit`;

const listMissingFilesStmt = db.prepare(`${MISSING_FILES_SELECT}${MISSING_FILES_TAIL}`);
const listMissingFilesByChatStmt = db.prepare(
  `${MISSING_FILES_SELECT} AND m.lineChatId = @chatId${MISSING_FILES_TAIL}`
);

export function listMissingFiles(opts: { limit?: number; chatId?: string }): MissingFileEntry[] {
  const limit = Math.min(Math.max(toInt(opts.limit) ?? 200, 1), 1000);
  const now = Date.now();
  const chatId = typeof opts.chatId === 'string' && opts.chatId.trim() ? opts.chatId.trim() : null;
  if (chatId) {
    return listMissingFilesByChatStmt.all({ now, limit, chatId }) as MissingFileEntry[];
  }
  return listMissingFilesStmt.all({ now, limit }) as MissingFileEntry[];
}
