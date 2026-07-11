/**
 * llm/index.ts — provider 抽象与选择。
 * 有 OPENAI_API_KEY → openai;否则 disabled(/api/summarize 回 503)。
 * provider-claude.ts 为预留实现。
 */

/** 阶段枚举(契约进度表五阶段 + 流失;繁体字面值,勿改) */
export const STAGES = ['洽談', '已回簽', '已打樣', '已出廠', '已交付', '流失'] as const;
export type Stage = (typeof STAGES)[number];

export interface NextAction {
  role: '跟单' | '设计' | '客服';
  action: string;
}

/** LLM 对进度表任务的判定(taskKey 对应 stageTemplate) */
export interface TaskStatus {
  taskKey: string;
  done: boolean;
  evidence?: string;
}

/** 文件角色枚举(缺档补件/档案分类;繁体字面值,勿改) */
export const DOC_ROLES = ['報價單', '回簽單', '設計圖', '刀模', '其他'] as const;
export type DocRole = (typeof DOC_ROLES)[number];

/** LLM 对某个「档案讯息」的角色判定(以 lineMessageId 关联该讯息 → 对应档案) */
export interface FileRole {
  lineMessageId: string;
  docRole: DocRole;
  evidence?: string;
}

/** LLM 结构化输出(契约 JSON 形状) */
export interface SummaryOutput {
  summaryText: string;
  stageGuess: Stage;
  keyFacts: { 产品?: string; 数量?: string; 规格?: string; 预算?: string };
  nextActions: NextAction[];
  /** 进度表五阶段任务的判定(backend 只写 source!='manual' 的行) */
  taskStatus: TaskStatus[];
  /** 大貨死線(承諾客戶的交期):侦测到才有;date 建议 'YYYY-MM-DD' */
  deadline?: { date: string | null; evidence: string | null };
  /** 每个档案讯息的角色判定(缺档补件 + 档案分类;以 lineMessageId 关联) */
  fileRoles: FileRole[];
}

/** summarize 可选参数:onDelta 为串流渐进回呼(不传则走非串流路径,行为不变) */
export interface SummarizeOptions {
  /** 每次串流增量后,回呼当前已抽取的 summaryText 部分文字(仅用于 UI 渐进显示,不影响最终解析) */
  onDelta?: (partialSummaryText: string) => void;
}

export interface LlmProvider {
  /** 'openai' | 'claude' */
  readonly name: string;
  readonly model: string;
  /** 输入 system + user prompt,返回结构化 JSON 结果;opts 可选,不传时行为与非串流一致 */
  summarize(systemPrompt: string, userPrompt: string, opts?: SummarizeOptions): Promise<SummaryOutput>;
}

/** 旧枚举 / 简体变体 → 契约五阶段字面值 的阶段归一化 */
const STAGE_ALIASES: Record<string, Stage> = {
  洽谈: '洽談',
  已报价: '洽談',
  已回签: '已回簽',
  已打样: '已打樣',
  已生产: '已打樣',
  已生產: '已打樣',
  已出厂: '已出廠',
  已成交: '已交付',
};

export function normalizeStage(raw: unknown): Stage {
  const s = String(raw ?? '').trim();
  if ((STAGES as readonly string[]).includes(s)) return s as Stage;
  if (STAGE_ALIASES[s]) return STAGE_ALIASES[s];
  return '洽談';
}

/** 旧枚举 / 简体变体 → 文件角色字面值 的归一化 */
const DOC_ROLE_ALIASES: Record<string, DocRole> = {
  报价单: '報價單',
  回签单: '回簽單',
  设计图: '設計圖',
  设计稿: '設計圖',
  設計稿: '設計圖',
  刀模图: '刀模',
  刀模圖: '刀模',
};

/** 把模型返回的角色字符串归一化为 DocRole;无法识别返回 null(不写入) */
export function normalizeDocRole(raw: unknown): DocRole | null {
  const s = String(raw ?? '').trim();
  if ((DOC_ROLES as readonly string[]).includes(s)) return s as DocRole;
  if (DOC_ROLE_ALIASES[s]) return DOC_ROLE_ALIASES[s];
  return null;
}

/** 把模型返回的任意 JSON 归一化为 SummaryOutput(容错) */
export function normalizeSummaryOutput(raw: unknown): SummaryOutput {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kf = (obj.keyFacts && typeof obj.keyFacts === 'object' ? obj.keyFacts : {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = kf[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
    }
    return undefined;
  };
  const roleMap: Record<string, NextAction['role']> = {
    跟单: '跟单', 跟單: '跟单', 设计: '设计', 設計: '设计', 客服: '客服',
  };
  const actionsRaw = Array.isArray(obj.nextActions) ? obj.nextActions : [];
  const nextActions: NextAction[] = actionsRaw
    .map((a): NextAction | null => {
      if (!a || typeof a !== 'object') return null;
      const r = roleMap[String((a as Record<string, unknown>).role ?? '').trim()] ?? '客服';
      const action = String((a as Record<string, unknown>).action ?? '').trim();
      return action ? { role: r, action } : null;
    })
    .filter((a): a is NextAction => a !== null);

  const taskStatusRaw = Array.isArray(obj.taskStatus) ? obj.taskStatus : [];
  const taskStatus: TaskStatus[] = taskStatusRaw
    .map((t): TaskStatus | null => {
      if (!t || typeof t !== 'object') return null;
      const o = t as Record<string, unknown>;
      const taskKey = String(o.taskKey ?? '').trim();
      if (!taskKey) return null;
      const done = o.done === true || o.done === 1 || o.done === '1' || o.done === 'true';
      const ev = o.evidence;
      const evidence = typeof ev === 'string' && ev.trim() ? ev.trim() : undefined;
      return { taskKey, done, evidence };
    })
    .filter((t): t is TaskStatus => t !== null);

  // 大貨死線
  let deadline: { date: string | null; evidence: string | null } | undefined;
  const dl = obj.deadline as Record<string, unknown> | undefined;
  if (dl && typeof dl === 'object') {
    const date = typeof dl.date === 'string' && dl.date.trim() ? dl.date.trim() : null;
    const evidence = typeof dl.evidence === 'string' && dl.evidence.trim() ? dl.evidence.trim() : null;
    if (date) deadline = { date, evidence };
  }

  // 文件角色:仅保留能解析出 lineMessageId 与合法 docRole 的项
  const fileRolesRaw = Array.isArray(obj.fileRoles) ? obj.fileRoles : [];
  const fileRoles: FileRole[] = fileRolesRaw
    .map((r): FileRole | null => {
      if (!r || typeof r !== 'object') return null;
      const o = r as Record<string, unknown>;
      const lineMessageId = String(o.lineMessageId ?? '').trim();
      if (!lineMessageId) return null;
      const docRole = normalizeDocRole(o.docRole);
      if (!docRole) return null;
      const ev = o.evidence;
      const evidence = typeof ev === 'string' && ev.trim() ? ev.trim() : undefined;
      return { lineMessageId, docRole, evidence };
    })
    .filter((r): r is FileRole => r !== null);

  return {
    summaryText: String(obj.summaryText ?? '').trim(),
    stageGuess: normalizeStage(obj.stageGuess),
    keyFacts: {
      产品: pick('产品', '產品'),
      数量: pick('数量', '數量'),
      规格: pick('规格', '規格'),
      预算: pick('预算', '預算'),
    },
    nextActions,
    taskStatus,
    deadline,
    fileRoles,
  };
}

import { OpenAIProvider } from './provider-openai.js';

let cached: LlmProvider | null | undefined;

/** 选择 provider;未配置任何 key 时返回 null(= disabled) */
export function getProvider(): LlmProvider | null {
  if (cached !== undefined) return cached;
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  if (openaiKey) {
    cached = new OpenAIProvider(openaiKey, process.env.LLM_MODEL?.trim() || 'gpt-5.5');
  } else {
    cached = null;
  }
  return cached;
}

export function llmStatus(): 'openai' | 'disabled' {
  return getProvider() ? 'openai' : 'disabled';
}
