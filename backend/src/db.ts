/**
 * db.ts — better-sqlite3 初始化 + migrations(CREATE TABLE IF NOT EXISTS)
 * 表结构以 CONTRACT.md 为准,时间一律 epoch ms 整数。
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** backend/ 根目录(src/ 的上一层) */
export const BACKEND_ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(BACKEND_ROOT, 'data');
export const STORAGE_FILES_DIR = path.join(BACKEND_ROOT, 'storage', 'files');
/** 上传落地前的临时目录(与 files 同卷,rename 原子生效) */
export const STORAGE_TMP_DIR = path.join(BACKEND_ROOT, 'storage', 'tmp');
/** webui 静态目录(由另一模块提供,可能不存在) */
export const WEBUI_DIR = path.resolve(BACKEND_ROOT, '..', 'webui');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(STORAGE_FILES_DIR, { recursive: true });
fs.mkdirSync(STORAGE_TMP_DIR, { recursive: true });

const db: Database.Database = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
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

CREATE TABLE IF NOT EXISTS messages (
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
  rawJson TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (lineChatId, timestamp);

CREATE TABLE IF NOT EXISTS files (
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
  expiredAt INTEGER
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineChatId TEXT NOT NULL,
  lineNoteId TEXT UNIQUE,
  body TEXT,
  createdAt INTEGER,
  updatedAt INTEGER
);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineChatId TEXT NOT NULL,
  summaryText TEXT,
  stageGuess TEXT,
  keyFacts TEXT,
  nextActions TEXT,
  model TEXT,
  coveredUntilTs INTEGER,
  createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS sync_state (
  lineChatId TEXT PRIMARY KEY,
  lastMessageTs INTEGER,
  lastSyncAt INTEGER,
  oldestMessageTs INTEGER,
  backfillDone INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_requests (
  lineChatId TEXT PRIMARY KEY,
  status TEXT CHECK (status IN ('pending','done','error')) DEFAULT 'pending',
  requestedAt INTEGER,
  completedAt INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS team_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineChatId TEXT NOT NULL,
  authorName TEXT NOT NULL,
  authorRole TEXT CHECK (authorRole IN ('跟單','設計','客服','管理')),
  userId INTEGER,
  body TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_chat ON team_messages (lineChatId, createdAt);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  displayName TEXT NOT NULL,
  role TEXT CHECK (role IN ('跟單','設計','客服','管理')) NOT NULL,
  passwordHash TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  userId INTEGER NOT NULL,
  createdAt INTEGER,
  expiresAt INTEGER
);

CREATE TABLE IF NOT EXISTS stage_tasks (
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

CREATE TABLE IF NOT EXISTS stage_meta (
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
  updatedAt INTEGER
);

CREATE TABLE IF NOT EXISTS mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teamMessageId INTEGER NOT NULL,
  lineChatId TEXT NOT NULL,
  kind TEXT NOT NULL,
  targetUserId INTEGER,
  targetFileId INTEGER,
  readAt INTEGER,
  createdAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mentions_user ON mentions (targetUserId, readAt);

CREATE TABLE IF NOT EXISTS summary_annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineChatId TEXT NOT NULL,
  summaryId INTEGER,
  userId INTEGER,
  userName TEXT,
  body TEXT NOT NULL,
  createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineChatId TEXT,
  userId INTEGER,
  userName TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  createdAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_chat ON audit_log (lineChatId, createdAt);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporterUserId INTEGER,
  reporterName TEXT,
  reporterRole TEXT,
  lineChatId TEXT,
  title TEXT NOT NULL,
  body TEXT,
  status TEXT DEFAULT 'open',
  adminNote TEXT,
  createdAt INTEGER,
  updatedAt INTEGER
);
`);

// migration:既有库的 summaries 表补 keyFacts 列(CREATE IF NOT EXISTS 不会改旧表)
{
  const cols = db.prepare('PRAGMA table_info(summaries)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'keyFacts')) {
    db.exec('ALTER TABLE summaries ADD COLUMN keyFacts TEXT');
  }
}

// migration:旧库补列(列已存在时 ALTER 抛错,忽略即可)
function tryAlter(sql: string): void {
  try {
    db.exec(sql);
  } catch {
    /* 列已存在 */
  }
}
tryAlter('ALTER TABLE sync_state ADD COLUMN oldestMessageTs INTEGER');
tryAlter('ALTER TABLE sync_state ADD COLUMN backfillDone INTEGER DEFAULT 0');
tryAlter('ALTER TABLE messages ADD COLUMN expiredAt INTEGER');
tryAlter('ALTER TABLE messages ADD COLUMN senderUserId TEXT');
tryAlter('ALTER TABLE messages ADD COLUMN senderName TEXT');
tryAlter('ALTER TABLE messages ADD COLUMN stickerId TEXT');
tryAlter('ALTER TABLE messages ADD COLUMN packageId TEXT');
tryAlter('ALTER TABLE team_messages ADD COLUMN userId INTEGER');
// 档案上传(同事)来源与上传者
tryAlter("ALTER TABLE files ADD COLUMN source TEXT DEFAULT 'line'");
tryAlter('ALTER TABLE files ADD COLUMN uploaderUserId INTEGER');
tryAlter('ALTER TABLE files ADD COLUMN uploaderName TEXT');
// AI 总结人工编辑
tryAlter('ALTER TABLE summaries ADD COLUMN editedText TEXT');
tryAlter('ALTER TABLE summaries ADD COLUMN editedByUserId INTEGER');
tryAlter('ALTER TABLE summaries ADD COLUMN editedByName TEXT');
tryAlter('ALTER TABLE summaries ADD COLUMN editedAt INTEGER');
// 大貨死線(承諾客戶的交期):LLM 侦测或人工设定,贯穿进度灯号做倒数/逾期警示
tryAlter('ALTER TABLE stage_meta ADD COLUMN deadlineAt INTEGER');
tryAlter("ALTER TABLE stage_meta ADD COLUMN deadlineSource TEXT");
tryAlter('ALTER TABLE stage_meta ADD COLUMN deadlineEvidence TEXT');
// 文件角色分类(報價單/回簽單/設計圖/刀模/其他):LLM 依对话+档名判定,人工可改
tryAlter('ALTER TABLE files ADD COLUMN docRole TEXT');
tryAlter('ALTER TABLE files ADD COLUMN docRoleSource TEXT');
tryAlter('ALTER TABLE messages ADD COLUMN docRole TEXT');

// ── 订单(一客户多张订单,各自日期范围 + 各自总结 + 进度)──────────────────
// 隔离式设计:订单进度用独立表(order_stage_tasks / order_stage_meta),
// 完全不动现有 stage_tasks / stage_meta（整體視圖=orderId 0，行为不变，零回归）。
db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineChatId TEXT NOT NULL,
  title TEXT,
  fromDate INTEGER,
  toDate INTEGER,
  createdByName TEXT,
  createdAt INTEGER,
  updatedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_chat ON orders (lineChatId, createdAt);

CREATE TABLE IF NOT EXISTS order_stage_tasks (
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

CREATE TABLE IF NOT EXISTS order_stage_meta (
  orderId INTEGER PRIMARY KEY,
  stageOverride TEXT,
  sampleLeadDays INTEGER, sampleStartAt INTEGER,
  productionLeadDays INTEGER, productionStartAt INTEGER,
  logisticsProvider TEXT, logisticsTrackingNo TEXT, logisticsNote TEXT,
  deadlineAt INTEGER, deadlineSource TEXT, deadlineEvidence TEXT,
  updatedAt INTEGER
);
`);
// summaries 加 orderId(0=整體;>0=某订单),additive 迁移
tryAlter('ALTER TABLE summaries ADD COLUMN orderId INTEGER DEFAULT 0');

// 客户标签(急件/VIP/负责业务…):共享标签定义 + 客户↔标签多对多
db.exec(`
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  color TEXT,
  createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS customer_tags (
  lineChatId TEXT NOT NULL,
  tagId INTEGER NOT NULL,
  createdAt INTEGER,
  UNIQUE (lineChatId, tagId)
);
CREATE INDEX IF NOT EXISTS idx_customer_tags_tag ON customer_tags (tagId);
CREATE INDEX IF NOT EXISTS idx_customer_tags_chat ON customer_tags (lineChatId);
`);

// LLM 用量追踪:每次总结呼叫记一笔,供管理员看成本/耗时/成功率
db.exec(`
CREATE TABLE IF NOT EXISTS llm_usage (
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
CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage (createdAt);
`);
// 订单归属改用稳定 userId(displayName 非 UNIQUE 且可改名,不可作授权凭据);
// createdByName 仅供显示。旧行 createdByUserId 为 NULL(建立者未知),仅管理可删。
tryAlter('ALTER TABLE orders ADD COLUMN createdByUserId INTEGER');

// missing-files 兜底查询用的部分索引(messages 可能几十万行,只索引带 contentHash 的档案消息)
db.exec(
  'CREATE INDEX IF NOT EXISTS idx_messages_contentHash ON messages (contentHash) WHERE contentHash IS NOT NULL'
);

// 按 lineChatId 过滤的相关子查询/列表查询加速(幂等,只加速不改行为):
// - files:CUSTOMER_SELECT 的 fileCount 子查询、listFiles、mentions suggest / fileInChat 都按 lineChatId 过滤
// - summaries:CUSTOMER_SELECT 取最新一条、listSummaries、latestSummary 缓存判断,均按 (lineChatId, createdAt) 取最新
// - summary_annotations:listAnnotations 按 (lineChatId, summaryId) 过滤排序
// - sessions:login 惰性清理 DELETE ... WHERE expiresAt < now
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_files_chat ON files (lineChatId);
  CREATE INDEX IF NOT EXISTS idx_summaries_chat_created ON summaries (lineChatId, createdAt);
  CREATE INDEX IF NOT EXISTS idx_annotations_chat_summary ON summary_annotations (lineChatId, summaryId);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expiresAt);
  CREATE INDEX IF NOT EXISTS idx_notes_chat ON notes (lineChatId, createdAt);
  CREATE INDEX IF NOT EXISTS idx_mentions_msg ON mentions (teamMessageId);
`);

// 规范化历史资料:早期 DEFAULT 为简体「洽谈」,权威阶段字面值是繁体「洽談」(stageTemplate.STAGE_ORDER[0])。
// 未曾计算过进度/总结的旧客户可能残留简体值,导致阶段筛选/徽章行为不一致。幂等,只影响残留简体行。
db.exec("UPDATE customers SET currentStage = '洽談' WHERE currentStage = '洽谈'");

export default db;
