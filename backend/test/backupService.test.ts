/**
 * backupService.test.ts — 备份档管理的安全边界(临时目录 + 临时库,绝不碰正式 app.db / backend/backups)。
 * BACKUP_NAME_RE / resolveBackupPath / pruneOld(retention) 的逻辑逐字复制自 src/services/backupService.ts,
 * 但把 BACKUPS_DIR 指向 os.tmpdir 下的一次性目录;runBackup 有效性用临时库自身的 db.backup() 验证。
 * 验证:
 *  - 线上备份产物是可再打开的有效 SQLite(SELECT count(*) 一致)。
 *  - retention 只删符合 app-*.sqlite 的旧档、保留数正确、绝不删非备份档。
 *  - resolveBackupPath 挡路径穿越(../ / 绝对路径 / 非 app-* 命名)回 null。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createTestDb, closeTestDb, assertNotRealDb, type TestDb } from './helpers.js';

// ── 逐字复制自 backupService.ts 的把关规则 ─────────────────────────────────
const BACKUP_NAME_RE = /^app-\d{8}-\d{6}\.sqlite$/;

let BACKUPS_DIR: string;
let T: TestDb;

beforeEach(() => {
  BACKUPS_DIR = path.join(os.tmpdir(), `lineoa-backuptest-${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  T = createTestDb();
});
afterEach(() => {
  closeTestDb(T);
  fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });
});

// resolveBackupPath(逐字复制,BACKUPS_DIR 换成测试目录):任何不合规回 null。
function resolveBackupPath(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  if (path.basename(name) !== name) return null;
  if (!BACKUP_NAME_RE.test(name)) return null;
  const full = path.resolve(BACKUPS_DIR, name);
  if (path.dirname(full) !== path.resolve(BACKUPS_DIR)) return null;
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  return full;
}

// listBackups(逐字复制核心:只认 BACKUP_NAME_RE,按 createdAt 倒序)
function listBackups(): { name: string; createdAt: number }[] {
  const out: { name: string; createdAt: number }[] = [];
  for (const name of fs.readdirSync(BACKUPS_DIR)) {
    if (!BACKUP_NAME_RE.test(name)) continue;
    const st = fs.statSync(path.join(BACKUPS_DIR, name));
    if (!st.isFile()) continue;
    out.push({ name, createdAt: Math.round(st.mtimeMs) });
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

// pruneOld(逐字复制:保留 keep 份,只删 resolveBackupPath 认可的旧档)
function pruneOld(keep: number): void {
  const doomed = listBackups().slice(keep);
  for (const it of doomed) {
    const full = resolveBackupPath(it.name);
    if (!full) continue;
    fs.unlinkSync(full);
  }
}

/** 造一个「像备份」的假档,mtime 由 order 决定(越大越新) */
function touchBackup(name: string, order: number): void {
  const p = path.join(BACKUPS_DIR, name);
  fs.writeFileSync(p, 'x');
  const t = new Date(Date.now() + order * 1000);
  fs.utimesSync(p, t, t);
}

test('runBackup 产物是有效 SQLite:可再打开并 SELECT count(*) 一致', async () => {
  const db = T.db;
  db.prepare('INSERT INTO customers (lineChatId, createdAt) VALUES (?, ?)').run('CB1', Date.now());
  db.prepare('INSERT INTO customers (lineChatId, createdAt) VALUES (?, ?)').run('CB2', Date.now());
  const dest = path.join(BACKUPS_DIR, `app-${'20260101'}-000000.sqlite`);
  assertNotRealDb(dest); // 兜底:备份目标绝不是正式库
  await db.backup(dest); // better-sqlite3 线上备份 API(runBackup 内核)
  assert.ok(fs.existsSync(dest) && fs.statSync(dest).size > 0, '备份档应落地且非空');

  const reopened = new Database(dest, { readonly: true });
  try {
    const n = (reopened.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n;
    assert.equal(n, 2, '备份内容与源库一致');
  } finally {
    reopened.close();
  }
});

test('retention:保留最近 keep 份,删掉更旧的备份档', () => {
  // 6 份备份,order 越大越新
  touchBackup('app-20260101-000000.sqlite', 1);
  touchBackup('app-20260102-000000.sqlite', 2);
  touchBackup('app-20260103-000000.sqlite', 3);
  touchBackup('app-20260104-000000.sqlite', 4);
  touchBackup('app-20260105-000000.sqlite', 5);
  touchBackup('app-20260106-000000.sqlite', 6);
  pruneOld(3);
  const remain = listBackups().map((b) => b.name);
  assert.equal(remain.length, 3, '只应保留 3 份');
  assert.deepEqual(
    remain,
    ['app-20260106-000000.sqlite', 'app-20260105-000000.sqlite', 'app-20260104-000000.sqlite'],
    '保留最新 3 份'
  );
});

test('retention:绝不删非备份档(命名不符 app-*.sqlite 一律保留)', () => {
  touchBackup('app-20260101-000000.sqlite', 1);
  touchBackup('app-20260102-000000.sqlite', 2);
  // 非备份命名的档案:不该被 prune 波及
  fs.writeFileSync(path.join(BACKUPS_DIR, 'important-notes.txt'), 'keep me');
  fs.writeFileSync(path.join(BACKUPS_DIR, 'app.db'), 'not a backup name');
  fs.writeFileSync(path.join(BACKUPS_DIR, 'app-2026.sqlite'), 'wrong pattern');
  pruneOld(1); // 只保留 1 份备份 → 删 1 份旧备份
  assert.ok(fs.existsSync(path.join(BACKUPS_DIR, 'important-notes.txt')), '.txt 应保留');
  assert.ok(fs.existsSync(path.join(BACKUPS_DIR, 'app.db')), 'app.db(非备份命名)应保留');
  assert.ok(fs.existsSync(path.join(BACKUPS_DIR, 'app-2026.sqlite')), '格式不符的应保留');
  // 备份档只剩最新那份
  assert.deepEqual(listBackups().map((b) => b.name), ['app-20260102-000000.sqlite']);
});

test('retention:keep >= 现有份数时不删任何档', () => {
  touchBackup('app-20260101-000000.sqlite', 1);
  touchBackup('app-20260102-000000.sqlite', 2);
  pruneOld(30);
  assert.equal(listBackups().length, 2);
});

test('resolveBackupPath:合法备份名 → 绝对路径(存在时)', () => {
  const name = 'app-20260101-120000.sqlite';
  touchBackup(name, 1);
  const full = resolveBackupPath(name);
  assert.equal(full, path.resolve(BACKUPS_DIR, name));
});

test('resolveBackupPath:路径穿越 / 绝对路径 / 非 app-* 命名一律回 null', () => {
  // 目录穿越
  assert.equal(resolveBackupPath('../app.db'), null);
  assert.equal(resolveBackupPath('../../data/app.db'), null);
  assert.equal(resolveBackupPath('sub/app-20260101-000000.sqlite'), null);
  assert.equal(resolveBackupPath('a\\b'), null);
  // 绝对路径
  assert.equal(resolveBackupPath('/etc/passwd'), null);
  assert.equal(resolveBackupPath('C:\\Windows\\system32\\config'), null);
  // 命名不符 app-YYYYMMDD-HHmmss.sqlite
  assert.equal(resolveBackupPath('app.db'), null);
  assert.equal(resolveBackupPath('app-2026-01-01.sqlite'), null);
  assert.equal(resolveBackupPath('app-20260101-000000.sqlite.bak'), null);
  assert.equal(resolveBackupPath('backup.sqlite'), null);
  // 类型/空
  assert.equal(resolveBackupPath(''), null);
  assert.equal(resolveBackupPath(null), null);
  assert.equal(resolveBackupPath(123 as unknown), null);
  // 合法命名但档案不存在 → null
  assert.equal(resolveBackupPath('app-20990101-000000.sqlite'), null);
});
