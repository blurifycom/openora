import type { PromptSpec, LLMResponse } from '@oss/domain-schemas';

export type { PromptSpec, LLMResponse };

export type LLMProvider = {
  complete(prompt: PromptSpec): Promise<LLMResponse>;
  embed(text: string): Promise<number[]>;
};

export type LLMProviderConfig = {
  provider: 'openrouter' | 'ollama' | 'openai' | 'anthropic';
  model: string;
  apiKey?: string;
  baseUrl?: string;
};
