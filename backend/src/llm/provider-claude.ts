/**
 * provider-claude.ts — 预留:实现 LlmProvider 接口。
 * 未配置 key 时任何调用直接抛「未配置」。日后接 Anthropic SDK 时补齐实现。
 */
import type { LlmProvider, SummaryOutput } from './index.js';

export class ClaudeProvider implements LlmProvider {
  readonly name = 'claude';
  readonly model: string;

  constructor(model = 'claude-opus-4-8') {
    this.model = model;
  }

  async summarize(_systemPrompt: string, _userPrompt: string): Promise<SummaryOutput> {
    throw new Error('Claude provider 未配置(缺少 ANTHROPIC_API_KEY,v1 未启用)');
  }
}
