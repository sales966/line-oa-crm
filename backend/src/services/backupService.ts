/**
 * backupService.ts — 内建自动备份排程 + 备份档管理(纯业务,routes 不直接碰 db/fs)。
 *
 * 用 better-sqlite3 的「线上备份 API」(db.backup(dest) 回 Promise)安全快照主库到
 * backend/backups/app-YYYYMMDD-HHmmss.sqlite。线上备份不锁库、不影响主流程读写。
 *
 * 安全边界:
 *  - 只在 backend/backups/ 里操作,且只认 app-YYYYMMDD-HHmmss.sqlite 命名;
 *    列表/删除/下载都靠这条正则把关,绝不触碰 data/ 的正式库或其他档案。
 *  - resolveBackupPath 防路径穿越(basename + 正则 + 目录归属三重校验)。
 *
 * 组态(env):
 *  - BACKUP_KEEP            保留最近几份(默认 30),多余旧档自动删。
 *  - BACKUP_INTERVAL_HOURS  排程间隔小时(默认 6)。
 */
import fs from 'node:fs';
import path from 'node:path';
import db, { BACKEND_ROOT } from '../db.js';

/** 备份档落地目录:backend/backups/(已 gitignore) */
export const BACKUPS_DIR = path.join(BACKEND_ROOT, 'backups');

/** 只认这种命名的备份档;列表/删除/下载全靠它把关,避免误伤 data/ 或手工命名的档案 */
const BACKUP_NAME_RE = /^app-\d{8}-\d{6}\.sqlite$/;

/** 启动即备份的「最近一份门槛」:1 小时内已有备份则略过,避免频繁重启狂备份 */
const STARTUP_SKIP_MS = 60 * 60 * 1000;

export interface BackupInfo {
  /** 绝对路径 */
  file: string;
  /** 档名(app-YYYYMMDD-HHmmss.sqlite) */
  name: string;
  sizeBytes: number;
  /** epoch ms */
  createdAt: number;
}

export type BackupListItem = Omit<BackupInfo, 'file'>;

// ---------- 工具 ----------

function ensureDir(): void {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

/** 本机时间组 YYYYMMDD-HHmmss(备份档命名用;人读友好、字典序=时间序) */
function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function readKeep(): number {
  const n = Number(process.env.BACKUP_KEEP);
  return Number.isInteger(n) && n > 0 ? n : 30;
}

function readIntervalHours(): number {
  const n = Number(process.env.BACKUP_INTERVAL_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

// ---------- 列表 ----------

/** 读 backend/backups/ 回 [{name,sizeBytes,createdAt}],按时间倒序(最新在前) */
export function listBackups(): BackupListItem[] {
  ensureDir();
  let names: string[];
  try {
    names = fs.readdirSync(BACKUPS_DIR);
  } catch {
    return [];
  }
  const out: BackupListItem[] = [];
  for (const name of names) {
    if (!BACKUP_NAME_RE.test(name)) continue; // 只认自家备份命名,略过其他档案
    try {
      const st = fs.statSync(path.join(BACKUPS_DIR, name));
      if (!st.isFile()) continue;
      out.push({ name, sizeBytes: st.size, createdAt: Math.round(st.mtimeMs) });
    } catch {
      /* 竞态被删/无法 stat:略过该档 */
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

// ---------- 路径解析(防穿越)----------

/**
 * 把外部传入的备份档名解析成安全的绝对路径;任何不合规一律回 null。
 * 三重把关:(1) 必须等于自身 basename(无目录分隔/穿越段);
 *          (2) 必须符合 app-YYYYMMDD-HHmmss.sqlite 命名;
 *          (3) 解析后必须仍落在 BACKUPS_DIR 内,且档案确实存在。
 */
export function resolveBackupPath(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  if (path.basename(name) !== name) return null; // 含 / \ .. 等一律挡
  if (!BACKUP_NAME_RE.test(name)) return null;
  const full = path.resolve(BACKUPS_DIR, name);
  // 归属校验:父目录必须正好是 BACKUPS_DIR(symlink/大小写卷等极端情况的兜底)
  if (path.dirname(full) !== path.resolve(BACKUPS_DIR)) return null;
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) return null;
  } catch {
    return null; // 不存在
  }
  return full;
}

// ---------- 保留策略 ----------

/** 保留最近 keep 份,删多余旧档(只删 BACKUPS_DIR 内符合 app-*.sqlite 的,绝不碰 data/) */
function pruneOld(keep: number): void {
  const items = listBackups(); // 已按时间倒序
  const doomed = items.slice(keep);
  for (const it of doomed) {
    const full = resolveBackupPath(it.name); // 再走一次防穿越校验才删
    if (!full) continue;
    try {
      fs.unlinkSync(full);
    } catch (err) {
      console.error('[backup] prune 删档失败', it.name, err);
    }
  }
}

// ---------- 备份 ----------

/**
 * 执行一次线上备份到 backend/backups/app-YYYYMMDD-HHmmss.sqlite,并套用保留策略。
 * 成功回 BackupInfo;失败会 throw(供 route 回 500;排程呼叫方另有 try/catch 兜底)。
 */
export async function runBackup(reason = 'manual'): Promise<BackupInfo> {
  ensureDir();
  const name = `app-${stamp(new Date())}.sqlite`;
  const file = path.join(BACKUPS_DIR, name);
  // better-sqlite3 线上备份:不锁库、不影响主流程读写
  await db.backup(file);
  const st = fs.statSync(file);
  const info: BackupInfo = {
    file,
    name,
    sizeBytes: st.size,
    createdAt: Math.round(st.mtimeMs),
  };
  try {
    pruneOld(readKeep());
  } catch (err) {
    // 保留策略失败不应让备份本身算失败(档已成功落地)
    console.error('[backup] 保留策略执行失败', err);
  }
  console.log(`[backup] 已备份 (${reason}) → ${name} (${info.sizeBytes} bytes)`);
  return info;
}

// ---------- 排程 ----------

/** 备份一次但吞掉例外(排程/启动用:失败记 log,绝不让计时器/启动崩) */
async function safeTick(reason: string): Promise<void> {
  try {
    await runBackup(reason);
  } catch (err) {
    console.error(`[backup] 备份失败 (${reason})`, err);
  }
}

/**
 * 启动备份排程:
 *  - 启动时先跑一次(但若最近一份在 1 小时内则略过,避免频繁重启狂备份);
 *  - 之后每 BACKUP_INTERVAL_HOURS 小时跑一次。
 * 回传 timer 供测试 clearInterval。由 server 启动呼叫(本模块不改 server.ts)。
 */
export function scheduleBackups(): NodeJS.Timeout {
  // 启动即备份(错开:最近一份太新就跳过)
  let recentEnough = false;
  try {
    const latest = listBackups()[0];
    if (latest && Date.now() - latest.createdAt < STARTUP_SKIP_MS) recentEnough = true;
  } catch {
    /* 读列表失败当作无备份,照跑 */
  }
  if (recentEnough) {
    console.log('[backup] 启动:最近一份备份在 1 小时内,略过启动备份');
  } else {
    void safeTick('startup');
  }

  const intervalMs = readIntervalHours() * 60 * 60 * 1000;
  const timer = setInterval(() => {
    void safeTick('scheduled');
  }, intervalMs);
  return timer;
}
