/**
 * provider-openai.ts — OpenAI chat.completions,response_format json_object。
 * 模型:env LLM_MODEL,默认 gpt-5.5。
 */
import OpenAI from 'openai';
import type { LlmProvider, SummaryOutput } from './index.js';
import { normalizeSummaryOutput } from './index.js';
import { LLM_TIMEOUT_MS } from '../config.js';

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

  async summarize(systemPrompt: string, userPrompt: string): Promise<SummaryOutput> {
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
}
