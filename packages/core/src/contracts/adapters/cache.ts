/**
 * Cache seam. Hot reads (public catalogue/content feeds, and short-lived per-player or
 * per-admin entries such as grants) load through this adapter so the backend is swappable. A
 * per-player entry must stay short-lived: seconds to minutes. The default binding is an
 * in-process TTL cache (zero deps), process-local so invalidation does NOT propagate across
 * replicas. Set REDIS_URL to bind the shipped Redis reference adapter (cross-replica
 * invalidation) with zero consumer code; rebind CACHE via an overlay for any other backend.
 */
import { createToken, type Token } from './token.js';

export type CacheAdapter = {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, opts: { ttlMs: number }): Promise<void>;
  setIfAbsent<T>(key: string, value: T, opts: { ttlMs: number }): Promise<boolean>;
  delete(key: string | string[]): Promise<void>;
};

export const CACHE: Token<CacheAdapter> = createToken('CACHE');
