/**
 * routes/admin-health.ts — 系统健康快照(唯读;仅 role=管理)。
 * 全局 auth hook 已保证 session 有效并装饰 req.user;此 plugin 内再加角色门槛(非管理 403)。
 *
 * GET /api/admin/health → {
 *   llm, db, sync, backup, recentErrors, uptimeSince
 * }
 * 设计原则:只读、健壮——任一子项读取失败只把该子项(或其字段)回 null,绝不让整个端点崩。
 * 不改 db.ts / server.ts;由协调者 Integrate 挂载本 plugin。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import db, { DATA_DIR, BACKEND_ROOT } from '../db.js';
import { llmStatus } from '../llm/index.js';

/** 进程启动时间:模块载入(= server 启动)那一刻,之后恒定不变 */
const UPTIME_SINCE = Date.now();

const DAY_MS = 86_400_000;
const APP_DB_PATH = path.join(DATA_DIR, 'app.db');
const BACKUP_DIR = path.join(BACKEND_ROOT, 'backups');

/** 包住任何可能抛错的读取;失败回 fallback,永不外抛 */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** 单表 COUNT(*);表不存在/查询失败回 null */
function countOf(table: string): number | null {
  return safe(() => {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
    return row.c;
  }, null);
}

interface DbSection {
  sizeBytes: number | null;
  customers: number | null;
  messages: number | null;
  files: number | null;
  summaries: number | null;
}

function dbSection(): DbSection {
  return {
    // 契约明确:读 backend/data/app.db 档案本身大小(WAL 模式下写入多半暂驻 -wal,故此值偏保守)
    sizeBytes: safe(() => fs.statSync(APP_DB_PATH).size, null),
    customers: countOf('customers'),
    messages: countOf('messages'),
    files: countOf('files'),
    summaries: countOf('summaries'),
  };
}

interface StaleCustomer {
  lineChatId: string;
  lineName: string | null;
  lastSyncAt: number | null;
}

interface SyncSection {
  lastSyncAt: number | null;
  /** 「watch」以 done=0(未结案)近似:逾 24h 未同步(含从未同步)的活跃客户数 */
  staleCustomers: number | null;
  /** 最久没同步的几个活跃客户(供管理员一眼定位) */
  staleSample: StaleCustomer[];
  /** sync_requests 里 status=pending 的待建构数 */
  pendingBuilds: number | null;
}

function syncSection(): SyncSection {
  const now = Date.now();
  const cutoff = now - DAY_MS;

  const lastSyncAt = safe(() => {
    const row = db.prepare('SELECT MAX(lastSyncAt) AS m FROM customers').get() as { m: number | null };
    return row.m ?? null;
  }, null);

  const staleCustomers = safe(() => {
    const row = db
      .prepare('SELECT COUNT(*) AS c FROM customers WHERE done = 0 AND (lastSyncAt IS NULL OR lastSyncAt < ?)')
      .get(cutoff) as { c: number };
    return row.c;
  }, null);

  const staleSample = safe<StaleCustomer[]>(() => {
    return db
      .prepare(
        `SELECT lineChatId, lineName, lastSyncAt
           FROM customers
          WHERE done = 0
          ORDER BY (lastSyncAt IS NULL) DESC, lastSyncAt ASC
          LIMIT 8`
      )
      .all() as StaleCustomer[];
  }, []);

  const pendingBuilds = safe(() => {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM sync_requests WHERE status = 'pending'")
      .get() as { c: number };
    return row.c;
  }, null);

  return { lastSyncAt, staleCustomers, staleSample, pendingBuilds };
}

interface BackupSection {
  dirExists: boolean;
  lastBackupAt: number | null;
  count: number | null;
}

function backupSection(): BackupSection {
  const dirExists = safe(() => fs.existsSync(BACKUP_DIR) && fs.statSync(BACKUP_DIR).isDirectory(), false);
  if (!dirExists) return { dirExists: false, lastBackupAt: null, count: null };

  const files = safe<string[]>(
    () => fs.readdirSync(BACKUP_DIR).filter((f) => f.toLowerCase().endsWith('.db')),
    []
  );

  const count = files.length;
  const lastBackupAt = safe<number | null>(() => {
    let newest: number | null = null;
    for (const f of files) {
      const mtime = safe(() => fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs, null);
      if (mtime !== null && (newest === null || mtime > newest)) newest = mtime;
    }
    return newest;
  }, null);

  return { dirExists: true, lastBackupAt, count };
}

interface RecentErrors {
  /** 最近几笔 LLM 失败(llm_usage.ok = 0) */
  llm: Array<{
    id: number;
    lineChatId: string | null;
    orderId: number | null;
    model: string | null;
    error: string | null;
    trigger: string | null;
    createdAt: number | null;
  }>;
  /** 最近几笔同步失败(sync_requests.error 非空 / status=error) */
  sync: Array<{
    lineChatId: string;
    status: string | null;
    error: string | null;
    completedAt: number | null;
  }>;
}

function recentErrors(): RecentErrors {
  const llm = safe<RecentErrors['llm']>(() => {
    return db
      .prepare(
        `SELECT id, lineChatId, orderId, model, error, trigger, createdAt
           FROM llm_usage
          WHERE ok = 0
          ORDER BY createdAt DESC
          LIMIT 10`
      )
      .all() as RecentErrors['llm'];
  }, []);

  const sync = safe<RecentErrors['sync']>(() => {
    return db
      .prepare(
        `SELECT lineChatId, status, error, completedAt
           FROM sync_requests
          WHERE error IS NOT NULL OR status = 'error'
          ORDER BY COALESCE(completedAt, requestedAt) DESC
          LIMIT 10`
      )
      .all() as RecentErrors['sync'];
  }, []);

  return { llm, sync };
}

export default async function adminHealthRoutes(app: FastifyInstance): Promise<void> {
  // 本 plugin 封装作用域内所有路由:仅限管理(不影响其他 plugin 的路由)
  app.addHook('onRequest', async (req, reply) => {
    if (!req.user || req.user.role !== '管理') {
      reply.code(403).send({ error: '僅限管理角色' });
    }
  });

  // GET /api/admin/health — 系统健康快照(只读)
  app.get('/api/admin/health', async () => {
    return {
      llm: safe<'openai' | 'disabled'>(() => llmStatus(), 'disabled'),
      db: dbSection(),
      sync: syncSection(),
      backup: backupSection(),
      recentErrors: recentErrors(),
      uptimeSince: UPTIME_SINCE,
    };
  });
}
