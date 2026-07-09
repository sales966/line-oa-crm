/**
 * config.ts — 集中常量与 env 覆盖(消除魔法数字散落)。
 * VERSION 直接从 package.json 读取,避免与其漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8')
) as { version?: string };

/** 版本号:唯一来源是 package.json */
export const VERSION: string = pkg.version ?? '0.0.0';

/** env 整数读取(无效/缺失时用默认值) */
function envInt(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : def;
}

/** 监听端口 */
export const PORT = envInt('PORT', 4680);

/** JSON body 上限(rawJson 可能较大);env BODY_LIMIT 可覆盖 */
export const BODY_LIMIT = envInt('BODY_LIMIT', 10 * 1024 * 1024);

/**
 * 单档上传上限(契约:300MB);env MAX_FILE_SIZE 可覆盖。
 * extension-sync 端同样以 300MB 为限(经 background 流式直传,不经 base64)。
 */
export const MAX_FILE_SIZE = envInt('MAX_FILE_SIZE', 300 * 1024 * 1024);

/** 消息分页 limit 的 clamp 上限 */
export const PAGE_LIMIT_MAX = 500;

/** 落地档案名最大长度(UTF-16 code unit;实际还会按剩余路径额度动态收紧) */
export const MAX_FILENAME_LEN = 180;

/** Windows MAX_PATH(260)扣除结尾 NUL 的完整路径预算 */
export const MAX_FULL_PATH_LEN = 259;

/** 同一 chatId 的 summarize 冷却时间;env SUMMARIZE_COOLDOWN_MS 可覆盖 */
export const SUMMARIZE_COOLDOWN_MS = envInt('SUMMARIZE_COOLDOWN_MS', 60_000);

/** LLM 请求超时;env LLM_TIMEOUT_MS 可覆盖。gpt-5.5 较慢,大客户可 40s+,故给 150s 余裕 */
export const LLM_TIMEOUT_MS = envInt('LLM_TIMEOUT_MS', 150_000);

/**
 * 单次总结 prompt 纳入的「最近」消息条数上限;env SUMMARIZE_MAX_MESSAGES 可覆盖。
 * 建档回填后强制总结的正是历史最庞大之时(可能上万条),不设上限会撑爆模型 context / 费用并抛错。
 * 取最近 N 条(时间倒序取后再转回正序);普通 chat(<N 条)行为不变,超大 chat 优雅降级为「最近 N 条」。
 */
export const SUMMARIZE_MAX_MESSAGES = envInt('SUMMARIZE_MAX_MESSAGES', 800);
