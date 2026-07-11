/**
 * tagService.ts — 客户标签(急件/VIP/负责业务…)业务逻辑。
 * 共享标签定义(tags)+ 客户↔标签多对多(customer_tags),routes 不直接碰 db。
 * schema 已在 db.ts 建好(勿改):
 *   tags(id, name UNIQUE, color, createdAt)
 *   customer_tags(lineChatId, tagId, createdAt, UNIQUE(lineChatId, tagId))
 * 写操作一律 recordAudit(tag_*)。时间 epoch ms。
 */
import db from '../db.js';
import { recordAudit, type AuditActor } from './auditService.js';

// ---------- 类型 ----------

export interface Tag {
  id: number;
  name: string;
  color: string | null;
  createdAt: number | null;
}

export type TagWriteResult = { ok: true; tag: Tag } | { ok: false; error: string; notFound?: boolean };

// route 传进来的 actor(与 auditService.AuditActor 同形状)
export type TagActor = AuditActor;

// ---------- 工具 ----------

const normName = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
// color 容错:非空字串才存,否则 null(schema 允许 NULL)
const normColor = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
};

// ---------- 标签定义:读 ----------

const listTagsStmt = db.prepare('SELECT id, name, color, createdAt FROM tags ORDER BY name ASC, id ASC');
const getTagByIdStmt = db.prepare('SELECT id, name, color, createdAt FROM tags WHERE id = ?');
const getTagByNameStmt = db.prepare('SELECT id, name, color, createdAt FROM tags WHERE name = ?');

export function listTags(): Tag[] {
  return listTagsStmt.all() as Tag[];
}

export function getTag(id: number): Tag | null {
  return (getTagByIdStmt.get(id) as Tag | undefined) ?? null;
}

// ---------- 标签定义:写(仅管理,权限由 route 检查)----------

const insertTagStmt = db.prepare(
  'INSERT INTO tags (name, color, createdAt) VALUES (?, ?, ?)'
);

/**
 * 建标签。name 唯一:若同名已存在,回既有(幂等,dedup:true),不视为错误;
 * name 空回 400(ok:false)。
 */
export function createTag(name: unknown, color: unknown, actor: TagActor): TagWriteResult & { dedup?: boolean } {
  const nm = normName(name);
  if (!nm) return { ok: false, error: '缺少标签名称' };
  const col = normColor(color);

  const existing = getTagByNameStmt.get(nm) as Tag | undefined;
  if (existing) return { ok: true, tag: existing, dedup: true };

  const now = Date.now();
  const res = insertTagStmt.run(nm, col, now);
  const tag: Tag = { id: Number(res.lastInsertRowid), name: nm, color: col, createdAt: now };
  recordAudit(null, actor, 'tag_create', String(tag.id), { name: nm, color: col });
  return { ok: true, tag };
}

const updateTagStmt = db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?');

/**
 * 改标签 name/color。只更新有提供的字段(name/color 皆可选);
 * 改后 name 撞其他标签 → 400;标签不存在 → notFound。
 */
export function updateTag(
  id: number,
  patch: { name?: unknown; color?: unknown },
  actor: TagActor
): TagWriteResult {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'id 不合法' };
  const cur = getTag(id);
  if (!cur) return { ok: false, error: '标签不存在', notFound: true };

  let nextName = cur.name;
  if (patch.name !== undefined) {
    const nm = normName(patch.name);
    if (!nm) return { ok: false, error: '标签名称不得为空' };
    nextName = nm;
  }
  let nextColor = cur.color;
  if (patch.color !== undefined) {
    nextColor = normColor(patch.color);
  }

  // name 撞其他标签(排除自身)→ 400
  if (nextName !== cur.name) {
    const clash = getTagByNameStmt.get(nextName) as Tag | undefined;
    if (clash && clash.id !== id) return { ok: false, error: '标签名称已存在' };
  }

  updateTagStmt.run(nextName, nextColor, id);
  const tag: Tag = { id, name: nextName, color: nextColor, createdAt: cur.createdAt };
  recordAudit(null, actor, 'tag_update', String(id), { name: nextName, color: nextColor });
  return { ok: true, tag };
}

const deleteTagStmt = db.prepare('DELETE FROM tags WHERE id = ?');
const deleteTagLinksStmt = db.prepare('DELETE FROM customer_tags WHERE tagId = ?');

/** 删标签定义,连带删所有客户↔该标签的关联(customer_tags)。 */
export function deleteTag(id: number, actor: TagActor): { ok: true } | { ok: false; error: string; notFound?: boolean } {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'id 不合法' };
  const cur = getTag(id);
  if (!cur) return { ok: false, error: '标签不存在', notFound: true };
  const tx = db.transaction(() => {
    deleteTagLinksStmt.run(id);
    deleteTagStmt.run(id);
  });
  tx();
  recordAudit(null, actor, 'tag_delete', String(id), { name: cur.name });
  return { ok: true };
}

// ---------- 客户↔标签:读 ----------

const getCustomerTagsStmt = db.prepare(`
  SELECT t.id, t.name, t.color
  FROM customer_tags ct
  JOIN tags t ON t.id = ct.tagId
  WHERE ct.lineChatId = ?
  ORDER BY t.name ASC, t.id ASC
`);

export interface CustomerTag {
  id: number;
  name: string;
  color: string | null;
}

/** 取某客户的标签清单 [{id,name,color}]。 */
export function getCustomerTags(chatId: string): CustomerTag[] {
  return getCustomerTagsStmt.all(chatId) as CustomerTag[];
}

/**
 * 批量取多个客户的标签(供 listCustomers 一次性附挂,避免 N 次查询)。
 * 回 Map<lineChatId, CustomerTag[]>;无标签的客户不在 Map 中(呼叫方给空数组兜底)。
 */
export function getTagsForChatIds(chatIds: string[]): Map<string, CustomerTag[]> {
  const out = new Map<string, CustomerTag[]>();
  if (chatIds.length === 0) return out;
  // 去重,并按批切分避免 SQLite 参数上限(默认 999)
  const uniq = [...new Set(chatIds)];
  const CHUNK = 400;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const batch = uniq.slice(i, i + CHUNK);
    const placeholders = batch.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT ct.lineChatId AS lineChatId, t.id AS id, t.name AS name, t.color AS color
         FROM customer_tags ct
         JOIN tags t ON t.id = ct.tagId
         WHERE ct.lineChatId IN (${placeholders})
         ORDER BY t.name ASC, t.id ASC`
      )
      .all(...batch) as { lineChatId: string; id: number; name: string; color: string | null }[];
    for (const r of rows) {
      let list = out.get(r.lineChatId);
      if (!list) {
        list = [];
        out.set(r.lineChatId, list);
      }
      list.push({ id: r.id, name: r.name, color: r.color });
    }
  }
  return out;
}

// ---------- 客户↔标签:写(任何登入者可给客户贴标签)----------

const deleteCustomerTagsStmt = db.prepare('DELETE FROM customer_tags WHERE lineChatId = ?');
const insertCustomerTagStmt = db.prepare(
  'INSERT OR IGNORE INTO customer_tags (lineChatId, tagId, createdAt) VALUES (?, ?, ?)'
);
const tagExistsStmt = db.prepare('SELECT 1 FROM tags WHERE id = ?');

/**
 * 整批覆盖某客户的标签:清掉旧关联,写入 tagIds 中「确实存在」的标签(去重、忽略不存在的 id)。
 * 回该客户覆盖后的标签清单。任何登入者可调用(权限由 route 保证已登入)。
 */
export function setCustomerTags(chatId: string, tagIds: unknown, actor: TagActor): CustomerTag[] {
  // 解析成合法正整数集合
  const ids: number[] = [];
  const seen = new Set<number>();
  if (Array.isArray(tagIds)) {
    for (const raw of tagIds) {
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
        seen.add(n);
        ids.push(n);
      }
    }
  }
  const now = Date.now();
  const tx = db.transaction(() => {
    deleteCustomerTagsStmt.run(chatId);
    for (const id of ids) {
      // 只写存在的标签,防止悬挂 id(schema 无外键约束)
      if (tagExistsStmt.get(id)) insertCustomerTagStmt.run(chatId, id, now);
    }
  });
  tx();
  const result = getCustomerTags(chatId);
  recordAudit(chatId, actor, 'tag_set', chatId, { tagIds: result.map((t) => t.id) });
  return result;
}
