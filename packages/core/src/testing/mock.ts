import type { DrizzleService } from '@blurifycom/core/server';

// The one sanctioned home for test-double type assertions. A unit test standing in
// for a collaborator is inherently partial, so the cast lives here - documented and
// in one place - instead of scattered `as unknown as` across every test body.
// See conventions: "Never cast" - test doubles are the single allowed exception,
// funnelled through these helpers.

/** Build a typed test double from a partial shape. */
export const mock = <T>(partial: object = {}): T => partial as unknown as T;

/** Wrap a fake `db` handle (usually a chainable Proxy) as a DrizzleService. */
export const mockDb = (db: unknown): DrizzleService => ({ db }) as unknown as DrizzleService;

/** Read a private field off an instance without widening the class's public API. */
export const readPrivate = <V = unknown>(obj: object, key: string): V =>
  (obj as Record<string, V>)[key];
