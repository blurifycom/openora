import type { LLMProvider, LLMProviderConfig } from '@oss/llm-provider-interface';
import type { PromptSpec, LLMResponse } from '@oss/domain-schemas';

export class OpenRouterProvider implements LLMProvider {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: LLMProviderConfig) {}

  async complete(_prompt: PromptSpec): Promise<LLMResponse> {
    throw new Error('OpenRouter provider not yet configured');
  }

  async embed(_text: string): Promise<number[]> {
    throw new Error('OpenRouter provider not yet configured');
  }
}
