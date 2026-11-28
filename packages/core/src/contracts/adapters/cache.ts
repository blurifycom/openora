import { createToken, type Token } from './token.js';

export type CacheAdapter = {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, opts: { ttlMs: number }): Promise<void>;
  setIfAbsent<T>(key: string, value: T, opts: { ttlMs: number }): Promise<boolean>;
  delete(key: string | string[]): Promise<void>;
};

export const CACHE: Token<CacheAdapter> = createToken('CACHE');
