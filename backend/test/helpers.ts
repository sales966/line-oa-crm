/**
 * helpers.ts — 测试用独立临时 SQLite 库 + 与 service 完全一致的 SQL 常量。
 *
 * 关键安全:测试**绝不能碰正式 data/app.db**。
 *  - createTestDb() 每次在 os.tmpdir() 建一个唯一临时档,测后 closeTestDb() 关闭并删除。
 *  - assertNotRealDb() 兜底断言:临时档路径永远不落在 backend/data/app.db 上。
 *
 * 为什么不直接 import service:src/db.ts 是单例连接,import 时就打开 data/app.db 并跑 migration。
 * 任何 import service(它们都 `import db from '../db.js'`)都会触碰正式库,违反红线。
 * 因此:纯函数(stageTemplate / llm normalize / summarizeGuard 不 import db)直接 import 真实代码测;
 * db 相关的不变量(manual 锁、订单隔离、死線倒数、auth、档案去重)则把 service 里**逐字复制**的 SQL
 * 跑在临时库上——不变量本体就在这些 SQL 里(如 `WHERE source != 'manual'`),故仍是对真实逻辑的验证。
 */
import Database from 'better-sqlite3';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** backend/data/app.db 的绝对路径——临时库绝不能等于它。 */
const REAL_DB_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
  'data',
  'app.db'
);

export interface TestDb {
  db: Database.Database;
  file: string;
}

/** 建 schema:逐字复制 db.ts 中本测试套件会用到的表(ALTER 补的列已折进 CREATE)。 */
const SCHEMA = `
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineChatId TEXT UNIQUE NOT NULL,
  lineName TEXT,
  chatType TEXT,
  done INTEGER DEFAULT 0,
  followedUp INTEGER DEFAULT 0,
  lastMessageAt INTEGER,
  lastSyncAt INTEGER,
  currentStage TEXT DEFAULT '洽談',
  lastSummaryId INTEGER,
  createdAt INTEGER,
  updatedAt INTEGER
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineChatId TEXT NOT NULL,
  lineMessageId TEXT UNIQUE,
  eventType TEXT,
  direction TEXT CHECK (direction IN ('in','out')),
  msgType TEXT,
  text TEXT,
  contentHash TEXT,
  fileName TEXT,
  fileSize INTEGER,
  senderUserId TEXT,
  senderName TEXT,
  timestamp INTEGER NOT NULL,
  expiredAt INTEGER,
  rawJson TEXT,
  docRole TEXT
);

CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineChatId TEXT NOT NULL,
  lineMessageId TEXT,
  fileName TEXT,
  fileSize INTEGER,
  contentHash TEXT UNIQUE NOT NULL,
  localPath TEXT NOT NULL,
  mimeType TEXT,
  uploadedAt INTEGER,
  downloadedAt INTEGER,
  expiredAt INTEGER,
  source TEXT DEFAULT 'line',
  uploaderUserId INTEGER,
  uploaderName TEXT,
  docRole TEXT,
  docRoleSource TEXT
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  displayName TEXT NOT NULL,
  role TEXT CHECK (role IN ('跟單','設計','客服','管理')) NOT NULL,
  passwordHash TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  createdAt INTEGER
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  userId INTEGER NOT NULL,
  createdAt INTEGER,
  expiresAt INTEGER
);

CREATE TABLE stage_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineChatId TEXT NOT NULL,
  stage TEXT NOT NULL,
  taskKey TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  source TEXT DEFAULT 'llm',
  evidence TEXT,
  updatedAt INTEGER,
  UNIQUE (lineChatId, taskKey)
);

CREATE TABLE stage_meta (
  lineChatId TEXT PRIMARY KEY,
  stageOverride TEXT,
  signedAt INTEGER,
  sampleLeadDays INTEGER,
  sampleStartAt INTEGER,
  productionLeadDays INTEGER,
  productionStartAt INTEGER,
  logisticsProvider TEXT,
  logisticsTrackingNo TEXT,
  logisticsNote TEXT,
  deadlineAt INTEGER,
  deadlineSource TEXT,
  deadlineEvidence TEXT,
  updatedAt INTEGER
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineChatId TEXT NOT NULL,
  title TEXT,
  fromDate INTEGER,
  toDate INTEGER,
  createdByName TEXT,
  createdByUserId INTEGER,
  createdAt INTEGER,
  updatedAt INTEGER
);

CREATE TABLE order_stage_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orderId INTEGER NOT NULL,
  stage TEXT NOT NULL,
  taskKey TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  source TEXT DEFAULT 'llm',
  evidence TEXT,
  updatedAt INTEGER,
  UNIQUE (orderId, taskKey)
);

CREATE TABLE order_stage_meta (
  orderId INTEGER PRIMARY KEY,
  stageOverride TEXT,
  sampleLeadDays INTEGER, sampleStartAt INTEGER,
  productionLeadDays INTEGER, productionStartAt INTEGER,
  logisticsProvider TEXT, logisticsTrackingNo TEXT, logisticsNote TEXT,
  deadlineAt INTEGER, deadlineSource TEXT, deadlineEvidence TEXT,
  updatedAt INTEGER
);

CREATE TABLE llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineChatId TEXT,
  orderId INTEGER DEFAULT 0,
  model TEXT,
  durationMs INTEGER,
  ok INTEGER DEFAULT 1,
  error TEXT,
  trigger TEXT,
  createdAt INTEGER
);

-- summaries:折入 db.ts 后续 ALTER 补的 orderId / edited* 列(供 search / dashboard no-summary 测)
CREATE TABLE summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineChatId TEXT NOT NULL,
  summaryText TEXT,
  stageGuess TEXT,
  keyFacts TEXT,
  nextActions TEXT,
  model TEXT,
  coveredUntilTs INTEGER,
  createdAt INTEGER,
  orderId INTEGER DEFAULT 0,
  editedText TEXT,
  editedByUserId INTEGER,
  editedByName TEXT,
  editedAt INTEGER
);

CREATE TABLE sync_requests (
  lineChatId TEXT PRIMARY KEY,
  status TEXT CHECK (status IN ('pending','done','error')) DEFAULT 'pending',
  requestedAt INTEGER,
  completedAt INTEGER,
  error TEXT
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineChatId TEXT,
  userId INTEGER,
  userName TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  createdAt INTEGER
);

-- 客户标签:共享标签定义 + 客户↔标签多对多(无外键,与正式库一致)
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  color TEXT,
  createdAt INTEGER
);
CREATE TABLE customer_tags (
  lineChatId TEXT NOT NULL,
  tagId INTEGER NOT NULL,
  createdAt INTEGER,
  UNIQUE (lineChatId, tagId)
);
`;

/** 建一个隔离的临时库(file-based,os.tmpdir),永不等于正式 app.db。 */
export function createTestDb(): TestDb {
  const file = path.join(os.tmpdir(), `lineoa-test-${process.pid}-${crypto.randomUUID()}.db`);
  if (path.resolve(file) === path.resolve(REAL_DB_PATH)) {
    throw new Error('拒绝:临时库路径撞上正式 app.db');
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return { db, file };
}

/** 关闭并删除临时库(含 -wal/-shm 边角档)。 */
export function closeTestDb(t: TestDb): void {
  try {
    t.db.close();
  } catch {
    /* 已关 */
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(t.file + suffix, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}

/** 兜底断言:确保某路径不是正式 app.db。 */
export function assertNotRealDb(file: string): void {
  if (path.resolve(file) === path.resolve(REAL_DB_PATH)) {
    throw new Error(`测试企图碰正式库:${file}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 以下 SQL 逐字复制自 src/services/*,让临时库跑与正式路径完全相同的语义。
// 若 service SQL 变了而这里没同步,对应测试会失效——即测试能反映真实不变量。
// ─────────────────────────────────────────────────────────────────────────────

/** progressService.upsertManualTaskStmt */
export const SQL_UPSERT_MANUAL_TASK = `
  INSERT INTO stage_tasks (lineChatId, stage, taskKey, done, source, evidence, updatedAt)
  VALUES (@chatId, @stage, @taskKey, @done, 'manual', @evidence, @now)
  ON CONFLICT(lineChatId, taskKey) DO UPDATE SET
    done = excluded.done,
    source = 'manual',
    evidence = CASE WHEN @setEvidence = 1 THEN @evidence ELSE stage_tasks.evidence END,
    updatedAt = excluded.updatedAt
`;

/** progressService.upsertLlmTaskStmt(手动优先:WHERE source != 'manual') */
export const SQL_UPSERT_LLM_TASK = `
  INSERT INTO stage_tasks (lineChatId, stage, taskKey, done, source, evidence, updatedAt)
  VALUES (@chatId, @stage, @taskKey, @done, 'llm', @evidence, @now)
  ON CONFLICT(lineChatId, taskKey) DO UPDATE SET
    done = excluded.done,
    evidence = excluded.evidence,
    updatedAt = excluded.updatedAt
  WHERE stage_tasks.source != 'manual'
`;

/** progressService.updateCustomerStageStmt(阶段未变则 0 行受影响) */
export const SQL_UPDATE_CUSTOMER_STAGE =
  'UPDATE customers SET currentStage = ?, updatedAt = ? WHERE lineChatId = ? AND currentStage IS NOT ?';

/** orderProgressService.upsertManualTaskStmt */
export const SQL_ORDER_UPSERT_MANUAL_TASK = `
  INSERT INTO order_stage_tasks (orderId, stage, taskKey, done, source, evidence, updatedAt)
  VALUES (@orderId, @stage, @taskKey, @done, 'manual', @evidence, @now)
  ON CONFLICT(orderId, taskKey) DO UPDATE SET
    done = excluded.done,
    source = 'manual',
    evidence = CASE WHEN @setEvidence = 1 THEN @evidence ELSE order_stage_tasks.evidence END,
    updatedAt = excluded.updatedAt
`;

/** authService.getSessionUserStmt(过期/停用一律查不到) */
export const SQL_GET_SESSION_USER = `
  SELECT u.id, u.username, u.displayName, u.role
  FROM sessions s JOIN users u ON u.id = s.userId
  WHERE s.token = ? AND s.expiresAt >= ? AND u.active = 1
`;

export const SQL_PURGE_EXPIRED_SESSIONS = 'DELETE FROM sessions WHERE expiresAt < ?';

/** fileService.upsertFileStmt(同 contentHash 去重 upsert) */
export const SQL_UPSERT_FILE = `
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
`;

/** docRoleService.updateFileDocRoleLlmStmt(人工设定过 source='manual' 不覆盖) */
export const SQL_UPDATE_FILE_DOCROLE_LLM = `
  UPDATE files SET docRole = @docRole, docRoleSource = 'llm'
  WHERE lineChatId = @chatId
    AND (docRoleSource IS NULL OR docRoleSource != 'manual')
    AND (
      (@contentHash IS NOT NULL AND contentHash = @contentHash)
      OR lineMessageId = @lineMessageId
    )
`;

const DAY_MS = 86_400_000;

/**
 * 复制自 progressService.buildDeadline 的天数差算法:
 * 以「当天 00:00」为基准,今天=0、未来>0、逾期<0;非数字返回 null。
 */
export function daysLeftFrom(at: number | null): number | null {
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfDeadline = new Date(at);
  startOfDeadline.setHours(0, 0, 0, 0);
  return Math.round((startOfDeadline.getTime() - startOfToday.getTime()) / DAY_MS);
}
