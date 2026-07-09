/**
 * fileDedup.test.ts — 档案去重 + docRole 归一化/同步不变量。
 * 覆盖:
 *  - 同 contentHash 二次 upsert 合并为单行(UNIQUE contentHash),metadata 以 COALESCE 补齐。
 *  - LLM 档案角色写入经 normalizeDocRole 归一化(简→繁)后落到 files.docRole。
 *  - 人工设定过角色(docRoleSource='manual')的档案不被 LLM 覆盖。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {
  createTestDb,
  closeTestDb,
  type TestDb,
  SQL_UPSERT_FILE,
  SQL_UPDATE_FILE_DOCROLE_LLM,
} from './helpers.js';
import { normalizeDocRole } from '../src/llm/index.js';

let T: TestDb;
let db: Database.Database;
const CHAT = 'Ctest-files';

beforeEach(() => {
  T = createTestDb();
  db = T.db;
});
afterEach(() => closeTestDb(T));

function upsertFile(p: {
  contentHash: string;
  fileName?: string | null;
  localPath: string;
  lineMessageId?: string | null;
  mimeType?: string | null;
}): void {
  db.prepare(SQL_UPSERT_FILE).run({
    lineChatId: CHAT,
    lineMessageId: p.lineMessageId ?? null,
    fileName: p.fileName ?? null,
    fileSize: null,
    contentHash: p.contentHash,
    localPath: p.localPath,
    mimeType: p.mimeType ?? null,
    uploadedAt: Date.now(),
    downloadedAt: Date.now(),
    expiredAt: null,
  });
}
const fileByHash = (h: string) =>
  db.prepare('SELECT * FROM files WHERE contentHash = ?').get(h) as
    | { id: number; fileName: string | null; localPath: string; mimeType: string | null; docRole: string | null; docRoleSource: string | null }
    | undefined;

test('同 contentHash 去重为单行,localPath 更新、metadata COALESCE 补齐', () => {
  upsertFile({ contentHash: 'hashA', fileName: '報價.pdf', localPath: '/store/a1', mimeType: null });
  upsertFile({ contentHash: 'hashA', fileName: null, localPath: '/store/a2', mimeType: 'application/pdf' });

  const rows = db.prepare('SELECT COUNT(*) AS n FROM files WHERE contentHash = ?').get('hashA') as { n: number };
  assert.equal(rows.n, 1, '同 contentHash 只应有一行');

  const row = fileByHash('hashA')!;
  assert.equal(row.localPath, '/store/a2', 'localPath 以最新为准');
  assert.equal(row.fileName, '報價.pdf', 'fileName 不被 NULL 覆盖(COALESCE)');
  assert.equal(row.mimeType, 'application/pdf', 'mimeType 由第二次补齐');
});

test('LLM docRole 经归一化(简→繁)后写入 files.docRole', () => {
  upsertFile({ contentHash: 'hashB', fileName: '设计.png', localPath: '/store/b', lineMessageId: 'msgB' });

  const docRole = normalizeDocRole('设计图'); // → 設計圖
  assert.equal(docRole, '設計圖');
  db.prepare(SQL_UPDATE_FILE_DOCROLE_LLM).run({
    chatId: CHAT,
    docRole,
    contentHash: 'hashB',
    lineMessageId: 'msgB',
  });

  const row = fileByHash('hashB')!;
  assert.equal(row.docRole, '設計圖');
  assert.equal(row.docRoleSource, 'llm');
});

test('人工设定过角色(manual)不被 LLM 覆盖', () => {
  upsertFile({ contentHash: 'hashC', fileName: 'x.pdf', localPath: '/store/c', lineMessageId: 'msgC' });
  // 人工先锁定为 報價單
  db.prepare("UPDATE files SET docRole = '報價單', docRoleSource = 'manual' WHERE contentHash = ?").run('hashC');

  // LLM 试图改为 設計圖 —— 应被 docRoleSource='manual' 挡下
  db.prepare(SQL_UPDATE_FILE_DOCROLE_LLM).run({
    chatId: CHAT,
    docRole: '設計圖',
    contentHash: 'hashC',
    lineMessageId: 'msgC',
  });

  const row = fileByHash('hashC')!;
  assert.equal(row.docRole, '報價單', '人工角色不被 LLM 覆盖');
  assert.equal(row.docRoleSource, 'manual');
});

test('LLM 可用 lineMessageId 关联(无 contentHash 命中时)', () => {
  upsertFile({ contentHash: 'hashD', fileName: 'y.pdf', localPath: '/store/d', lineMessageId: 'msgD' });
  db.prepare(SQL_UPDATE_FILE_DOCROLE_LLM).run({
    chatId: CHAT,
    docRole: '刀模',
    contentHash: null, // 无 contentHash,退回 lineMessageId 关联
    lineMessageId: 'msgD',
  });
  assert.equal(fileByHash('hashD')!.docRole, '刀模');
});
