/**
 * provider-openai.ts — OpenAI chat.completions,response_format json_object。
 * 模型:env LLM_MODEL,默认 gpt-5.5。
 */
import OpenAI from 'openai';
import type { LlmProvider, SummaryOutput, SummarizeOptions } from './index.js';
import { normalizeSummaryOutput } from './index.js';
import { LLM_TIMEOUT_MS } from '../config.js';

/**
 * 从「累积中的(可能不完整的)JSON 字串」渐进抽取 summaryText 字段的当前值。
 * 找 '"summaryText":"' 之后到下一个未转义 '"' 之间的内容,并把 JSON 转义(如 \n)还原。
 * 纯读取、绝不抛错(内部不使用 JSON.parse);字段尚未出现返回 null,字串未闭合则返回已累积部分。
 */
function extractPartialSummaryText(buffer: string): string | null {
  const m = /"summaryText"\s*:\s*"/.exec(buffer);
  if (!m) return null;
  let i = m.index + m[0].length;
  let out = '';
  while (i < buffer.length) {
    const ch = buffer[i];
    if (ch === '\\') {
      const next = buffer[i + 1];
      if (next === undefined) break; // 结尾处转义未完整,先停在这
      switch (next) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'u': {
          const hex = buffer.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
          }
          return out; // \u 转义未完整,返回已累积部分
        }
        default: out += next; break;
      }
      i += 2;
      continue;
    }
    if (ch === '"') return out; // 遇到未转义的闭合引号 → 字串结束
    out += ch;
    i += 1;
  }
  return out; // 字串尚未闭合,返回目前已累积的部分
}

export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';
  readonly model: string;
  private client: OpenAI;

  constructor(apiKey: string, model: string) {
    // 显式 timeout(env LLM_TIMEOUT_MS,默认 150s)+ 自动重试 3 次:
    // SDK 对 429(限流)/5xx/连线错误会指数退避重试,吸收一时性失败,不把它丢给使用者
    this.client = new OpenAI({ apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 3 });
    this.model = model;
  }

  async summarize(systemPrompt: string, userPrompt: string, opts?: SummarizeOptions): Promise<SummaryOutput> {
    // 有 onDelta → 走串流通道(渐进抽取 summaryText);无则走原本的非串流路径(行为一字不动)。
    if (opts?.onDelta) {
      return this.summarizeStreaming(systemPrompt, userPrompt, opts.onDelta);
    }
    let res;
    try {
      res = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      });
    } catch (err: unknown) {
      // 重试用尽后仍失败:给使用者可理解的中文讯息(前端直接显示)
      const e = err as { status?: number; message?: string };
      if (e?.status === 429) throw new Error('AI 服務忙碌(用量達上限),請稍後再試');
      if (e?.status === 401) throw new Error('OpenAI 金鑰無效,請檢查 backend/.env 的 OPENAI_API_KEY');
      const msg = typeof e?.message === 'string' ? e.message : '';
      if (/timeout|timed out|ETIMEDOUT|aborted/i.test(msg)) throw new Error('AI 生成逾時,請稍後再試(或該客戶對話過長)');
      throw new Error('AI 生成失敗:' + (msg || '未知錯誤'));
    }
    const content = res.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM 回應為空');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('LLM 回應不是合法 JSON');
    }
    return normalizeSummaryOutput(parsed);
  }

  /**
   * 串流路径:stream:true 累积 chunk,每次 delta 后渐进抽取 summaryText 呼叫 onDelta;
   * 串流结束后,用累积的完整字串走「与非串流完全相同」的 JSON.parse + normalizeSummaryOutput。
   * 逾时保护:每收到一个 chunk 重置计时器,若 LLM_TIMEOUT_MS 内无新 chunk 则中断并抛既有中文逾时错误。
   */
  private async summarizeStreaming(
    systemPrompt: string,
    userPrompt: string,
    onDelta: (partialSummaryText: string) => void,
  ): Promise<SummaryOutput> {
    let buffer = '';
    let lastPartial: string | null = null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, LLM_TIMEOUT_MS);
    };

    try {
      resetTimer();
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' },
          stream: true,
        },
        { signal: controller.signal },
      );
      for await (const chunk of stream) {
        resetTimer();
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta !== 'string' || delta === '') continue;
        buffer += delta;
        // 抽取与回呼一律 try/catch 包住:任何失败绝不可影响最终解析
        try {
          const partial = extractPartialSummaryText(buffer);
          if (partial !== null && partial !== lastPartial) {
            lastPartial = partial;
            onDelta(partial);
          }
        } catch {
          /* 渐进抽取/回呼失败:忽略,仅影响 UI 渐进显示,不影响最终 JSON 解析 */
        }
      }
    } catch (err: unknown) {
      // 逾时(watchdog abort)优先映射为既有中文逾时讯息
      if (timedOut) throw new Error('AI 生成逾時,請稍後再試(或該客戶對話過長)');
      const e = err as { status?: number; message?: string };
      if (e?.status === 429) throw new Error('AI 服務忙碌(用量達上限),請稍後再試');
      if (e?.status === 401) throw new Error('OpenAI 金鑰無效,請檢查 backend/.env 的 OPENAI_API_KEY');
      const msg = typeof e?.message === 'string' ? e.message : '';
      if (/timeout|timed out|ETIMEDOUT|abort/i.test(msg)) throw new Error('AI 生成逾時,請稍後再試(或該客戶對話過長)');
      throw new Error('AI 生成失敗:' + (msg || '未知錯誤'));
    } finally {
      if (timer) clearTimeout(timer);
    }

    // 串流结束:与非串流完全相同的解析路径
    if (!buffer) throw new Error('LLM 回應為空');
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer);
    } catch {
      throw new Error('LLM 回應不是合法 JSON');
    }
    return normalizeSummaryOutput(parsed);
  }
}
