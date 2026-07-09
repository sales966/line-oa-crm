/**
 * summaryService.ts — LLM 总结:取全部 text 消息 + notes + 档案清单,
 * 调 provider,存 summaries,更新 customers.currentStage / lastSummaryId。
 * Prompt 繁体中文;输出 JSON 结构与阶段枚举以 CONTRACT.md 字面值为准。
 */
import db from '../db.js';
import { getProvider } from '../llm/index.js';
import { STAGE_ORDER, STAGE_TASKS } from '../stageTemplate.js';
import { applyLlmTaskStatus, applyLlmDeadline, computeCurrentStage } from './progressService.js';
import { recordAudit, type AuditActor } from './auditService.js';
import { SUMMARIZE_MAX_MESSAGES } from '../config.js';

/** 由 stageTemplate 生成五阶段任务清單文字,附進 system prompt 讓 LLM 逐項判定 */
const TASK_CHECKLIST_TEXT = STAGE_ORDER.map((stage) => {
  const items = STAGE_TASKS[stage].map((t) => `    - ${t.taskKey}:${t.label}`).join('\n');
  return `  【${stage}】\n${items}`;
}).join('\n');

const SYSTEM_PROMPT = `你是台灣一家包裝公司(主營紙盒、禮盒、紙袋)的業務助理。客服人員透過 LINE 官方帳號與客戶洽談訂製包裝的需求。
請閱讀提供的完整對話紀錄、記事本內容與檔案清單,產出客戶進度總結,並逐項判定「進度表任務」的完成狀態。

你必須輸出「單一 JSON 物件」,不得包含其他文字,結構如下(鍵名必須完全一致):
{
  "summaryText": "以繁體中文、【條列式重點】呈現(不要寫成一段文章)。每一點獨立一行、以「• 」開頭,精簡扼要。依序涵蓋:客戶背景、需求/規格、數量與報價、目前進度、待釐清或待辦事項;每點一句話講清楚",
  "stageGuess": "必須是以下字串之一:洽談 | 已回簽 | 已打樣 | 已出廠 | 已交付 | 流失",
  "keyFacts": { "产品": "產品品項(未知填空字串)", "数量": "數量(未知填空字串)", "规格": "尺寸/材質/印刷等規格(未知填空字串)", "预算": "預算或報價金額(未知填空字串)" },
  "nextActions": [ { "role": "跟单 或 设计 或 客服", "action": "建議的下一步行動(繁體中文)" } ],
  "taskStatus": [ { "taskKey": "任務鍵(見下方清單)", "done": true 或 false, "evidence": "done=true 時必填:引用對話中證明此任務達成的關鍵訊息原文(≤30字)並標註日期與說話方,格式如「客戶 7/1『已用印 請收』」或「我方 7/1『請查收報價單』」;done=false 可留空" } ],
  "deadline": { "date": "承諾客戶的【大貨/正式貨交期死線】,格式 YYYY-MM-DD;若對話僅講相對時間(如『月底前』『聖誕節前』『農曆年前』)請換算成具體日期;完全沒提到交期則填 null", "evidence": "引用對話中提到交期的原文(≤30字)+日期,如「我方 7/2『大貨最慢 8/15 出貨』」;無則 null" }
}

階段判定參考(五階段固定順序:洽談 → 已回簽 → 已打樣 → 已出廠 → 已交付;流失為旁支):
- 洽談:仍在了解需求、規格、數量、預算,或已出報價單但尚未回簽。
- 已回簽:客戶已回簽報價單(案件成立),進入打樣、收打樣訂金、寄樣、確認樣品階段。
- 已打樣:客戶確定生產,收生產訂金/確認下單、安排大貨、確認交期。
- 已出廠:大貨完成,安排物流、國際物流資料、通知出貨。
- 已交付:客戶簽收、尾款結清、結案。
- 流失:客戶明確拒絕或長期未回覆且無後續。

進度表任務清單(taskStatus 只能使用以下 taskKey,依對話證據逐項判定 done;無把握或無提及一律 done=false):
${TASK_CHECKLIST_TEXT}

判定原則:僅在對話/記事本/檔案有明確證據時才把某任務標為 done;證據不足時 done=false,stageGuess 保守選擇較早的階段。summaryText、evidence 與 nextActions 一律使用繁體中文。`;

interface MsgRow {
  direction: string | null;
  msgType: string | null;
  text: string | null;
  fileName: string | null;
  timestamp: number;
}

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
  } catch {
    return String(ms);
  }
}

// 取「最近」N 条(时间倒序 + LIMIT),呈现时再 reverse 回时间正序。
// 超大 chat(建档回填后)不会把整部历史塞进 prompt,避免撑爆 context / 费用而抛错。
const promptMsgsStmt = db.prepare(
  `SELECT direction, msgType, text, fileName, timestamp FROM messages
   WHERE lineChatId = ? ORDER BY timestamp DESC, id DESC LIMIT ?`
);
const promptNotesStmt = db.prepare(
  'SELECT body, createdAt FROM notes WHERE lineChatId = ? ORDER BY createdAt ASC'
);
const promptFilesStmt = db.prepare(
  'SELECT fileName, fileSize, uploadedAt FROM files WHERE lineChatId = ? ORDER BY id ASC'
);
const promptCustomerStmt = db.prepare('SELECT lineName FROM customers WHERE lineChatId = ?');
// 最近 100 条团队内部讨论(先取最新 100 条,呈现时再转回时间正序)
const promptTeamMsgsStmt = db.prepare(
  `SELECT authorName, authorRole, body, createdAt FROM team_messages
   WHERE lineChatId = ? ORDER BY createdAt DESC, id DESC LIMIT 100`
);

/** 组装 user prompt(对话按时间正序) */
function buildUserPrompt(chatId: string): { prompt: string; coveredUntilTs: number; hasContent: boolean } {
  // DESC + LIMIT 取最近 N 条,reverse 回时间正序;coveredUntilTs 仍等于全表最新时间(最近一条即最新)
  const msgs = (promptMsgsStmt.all(chatId, SUMMARIZE_MAX_MESSAGES) as MsgRow[]).reverse();

  const notes = promptNotesStmt.all(chatId) as { body: string | null; createdAt: number | null }[];

  const files = promptFilesStmt.all(chatId) as {
    fileName: string | null;
    fileSize: number | null;
    uploadedAt: number | null;
  }[];

  const customer = promptCustomerStmt.get(chatId) as { lineName: string | null } | undefined;

  const teamMsgs = (
    promptTeamMsgsStmt.all(chatId) as {
      authorName: string;
      authorRole: string | null;
      body: string;
      createdAt: number;
    }[]
  ).reverse();

  // coveredUntilTs 只跟客户消息(messages)走,内部讨论不影响它
  let coveredUntilTs = 0;
  const lines: string[] = [];
  for (const m of msgs) {
    if (m.timestamp > coveredUntilTs) coveredUntilTs = m.timestamp;
    const who = m.direction === 'in' ? '客戶' : m.direction === 'out' ? '我方客服' : '系統';
    if (m.msgType === 'text' && m.text) {
      lines.push(`[${fmtTime(m.timestamp)}] ${who}:${m.text}`);
    } else if (m.msgType && m.msgType !== 'text') {
      // 非文字消息以占位说明呈现(图片/档案对判断阶段有帮助)
      const label = m.fileName ? `傳送檔案「${m.fileName}」` : `傳送 ${m.msgType} 訊息`;
      lines.push(`[${fmtTime(m.timestamp)}] ${who}:(${label})`);
    }
  }

  const parts: string[] = [];
  parts.push(`【客戶名稱】${customer?.lineName ?? '(未知)'}(chatId: ${chatId})`);
  parts.push('');
  parts.push('【對話紀錄(時間正序)】');
  parts.push(lines.length ? lines.join('\n') : '(無文字對話)');
  parts.push('');
  parts.push('【記事本】');
  parts.push(
    notes.length ? notes.map((n) => `- ${n.body ?? ''}`).join('\n') : '(無記事本)'
  );
  parts.push('');
  parts.push('【檔案清單】');
  parts.push(
    files.length
      ? files
          .map((f) => `- ${f.fileName ?? '(未命名)'}${f.fileSize ? `(${Math.round(f.fileSize / 1024)} KB)` : ''}`)
          .join('\n')
      : '(無檔案)'
  );

  // 有内部讨论才加该区块;讨论代表团队判断与约束,LLM 须纳入考量但不得当成已告知客户的事实
  if (teamMsgs.length) {
    parts.push('');
    parts.push('【內部討論(僅供內部,客戶不可見)】');
    parts.push(
      '以下為團隊成員的內部討論,代表團隊的判斷與約束(例如報價底線、設計要求、老闆指示)。' +
        '產出總結與 nextActions 時必須把這些納入考量,但這些內容客戶看不到,' +
        '不得把內部討論的內容當成已告知客戶的事實。'
    );
    parts.push(
      teamMsgs
        .map((t) => `[${fmtTime(t.createdAt)}] ${t.authorName}(${t.authorRole ?? '未知'}):${t.body}`)
        .join('\n')
    );
  }

  const hasContent = lines.length > 0 || notes.length > 0;
  return { prompt: parts.join('\n'), coveredUntilTs, hasContent };
}

const insertSummaryStmt = db.prepare(`
  INSERT INTO summaries (lineChatId, summaryText, stageGuess, keyFacts, nextActions, model, coveredUntilTs, createdAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

// currentStage 由 progressService.computeCurrentStage 依任务/override 计算,此处只更新 lastSummaryId
const updateCustomerSummaryStmt = db.prepare(`
  UPDATE customers SET lastSummaryId = ?, updatedAt = ? WHERE lineChatId = ?
`);

const customerExistsStmt = db.prepare('SELECT id FROM customers WHERE lineChatId = ?');

const latestSummaryStmt = db.prepare(
  'SELECT * FROM summaries WHERE lineChatId = ? ORDER BY createdAt DESC, id DESC LIMIT 1'
);
const latestMsgTsStmt = db.prepare(
  'SELECT MAX(timestamp) AS t FROM messages WHERE lineChatId = ?'
);
const latestTeamMsgTsStmt = db.prepare(
  'SELECT MAX(createdAt) AS t FROM team_messages WHERE lineChatId = ?'
);

interface StoredSummaryRow {
  id: number;
  lineChatId: string;
  summaryText: string | null;
  stageGuess: string | null;
  keyFacts: string | null;
  nextActions: string | null;
  model: string | null;
  coveredUntilTs: number | null;
  createdAt: number | null;
}

export interface SummaryShape {
  id: number;
  lineChatId: string;
  summaryText: string | null;
  stageGuess: string | null;
  keyFacts: unknown;
  nextActions: unknown;
  model: string | null;
  coveredUntilTs: number | null;
  createdAt: number | null;
}

function parseJsonOr<T>(text: string | null, fallback: T): unknown {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function shapeStoredSummary(row: StoredSummaryRow): SummaryShape {
  return {
    ...row,
    keyFacts: parseJsonOr(row.keyFacts, {}),
    nextActions: parseJsonOr(row.nextActions, []),
  };
}

export type SummarizeResult =
  | { ok: true; cached: boolean; summary: SummaryShape }
  | { ok: false; status: number; error: string };

export async function summarizeChat(
  chatId: string,
  opts: { force?: boolean; actor?: AuditActor } = {}
): Promise<SummarizeResult> {
  const provider = getProvider();
  if (!provider) return { ok: false, status: 503, error: 'LLM 未配置' };

  const customer = customerExistsStmt.get(chatId);
  if (!customer) return { ok: false, status: 404, error: '客户不存在' };

  // 缓存:最新 summary 已覆盖到最新消息且未带 force → 直接回缓存,不调 LLM。
  // coveredUntilTs 只跟客户消息走;但有新内部讨论(team_message.createdAt > summary.createdAt)时缓存失效。
  if (opts.force !== true) {
    const latest = latestSummaryStmt.get(chatId) as StoredSummaryRow | undefined;
    if (latest && latest.coveredUntilTs !== null) {
      const latestMsgTs = (latestMsgTsStmt.get(chatId) as { t: number | null }).t ?? 0;
      const latestTeamTs = (latestTeamMsgTsStmt.get(chatId) as { t: number | null }).t ?? 0;
      if (latest.coveredUntilTs >= latestMsgTs && latestTeamTs <= (latest.createdAt ?? 0)) {
        return { ok: true, cached: true, summary: shapeStoredSummary(latest) };
      }
    }
  }

  const { prompt, coveredUntilTs, hasContent } = buildUserPrompt(chatId);
  if (!hasContent) return { ok: false, status: 400, error: '該聊天沒有可總結的內容' };

  const output = await provider.summarize(SYSTEM_PROMPT, prompt);

  const now = Date.now();
  const res = insertSummaryStmt.run(
    chatId,
    output.summaryText,
    output.stageGuess,
    JSON.stringify(output.keyFacts),
    JSON.stringify(output.nextActions),
    `${provider.name}:${provider.model}`,
    coveredUntilTs,
    now
  );
  const summaryId = Number(res.lastInsertRowid);
  updateCustomerSummaryStmt.run(summaryId, now, chatId);

  // 审计:总结重生(CONTRACT §「AI 總結」列明重生须记 audit_log,action=summary_regenerate)。
  // 仅非缓存(真的调用了 LLM 另存新行)才记;actor 由调用方传入(webui=session user,建档自动=系统)。
  recordAudit(chatId, opts.actor ?? { userId: null, userName: '系統' }, 'summary_regenerate', String(summaryId), {
    model: `${provider.name}:${provider.model}`,
    coveredUntilTs,
    force: opts.force === true,
  });

  // 进度表:写 LLM 判定的 taskStatus(手动行不覆盖),再依任务/override 计算 currentStage。
  // stageOverride 存在时 computeCurrentStage 会锁定用它,LLM 结果仅存参考。
  try {
    applyLlmTaskStatus(chatId, output.taskStatus ?? []);
    if (output.deadline && output.deadline.date) {
      applyLlmDeadline(chatId, output.deadline.date, output.deadline.evidence ?? null);
    }
    computeCurrentStage(chatId);
  } catch {
    /* 进度表更新失败不拖垮总结主流程 */
  }

  return {
    ok: true,
    cached: false,
    summary: {
      id: summaryId,
      lineChatId: chatId,
      summaryText: output.summaryText,
      stageGuess: output.stageGuess,
      keyFacts: output.keyFacts,
      nextActions: output.nextActions,
      model: `${provider.name}:${provider.model}`,
      coveredUntilTs,
      createdAt: now,
    },
  };
}
