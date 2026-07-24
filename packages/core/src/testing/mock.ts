import { vi, type Mock } from 'vitest';
import type { DrizzleService } from '@openora/core/server';
import type { ClientMeta } from '@openora/core/contracts';

// The one sanctioned home for test-double type assertions. A unit test standing in
// for a collaborator is inherently partial, so the cast lives here - documented and
// in one place - instead of scattered `as unknown as` across every test body.
// See conventions: "Never cast" - test doubles are the single allowed exception,
// funnelled through these helpers.

/** Build a typed test double from a partial shape. */
export const mock = <T>(partial: object = {}): T => partial as unknown as T;

/** Wrap a fake `db` handle (usually a chainable Proxy) as a DrizzleService. */
export const mockDb = (db: unknown): DrizzleService => ({ db }) as unknown as DrizzleService;

/** Client metadata for a service call that has no HTTP request behind it (unit tests, jobs, seeds). */
export const NO_CLIENT_META: ClientMeta = { ip: null, userAgent: null };

/** Read a private field off an instance without widening the class's public API. */
export const readPrivate = <V = unknown>(obj: object, key: string): V =>
  (obj as Record<string, V>)[key];

type Row = Record<string, unknown>;

// Chainable, awaitable Drizzle double: awaiting the builder pops the next `select` queue entry,
// `.returning()` pops the `returning` queue - a test supplies per-statement results in call order.
export function makeQueryBuilder(results: { select: Row[][]; returning: Row[][] }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const m of [
    'select',
    'from',
    'innerJoin',
    'leftJoin',
    'orderBy',
    'groupBy',
    'limit',
    'offset',
    'for',
    'insert',
    'values',
    'onConflictDoNothing',
    'onConflictDoUpdate',
    'update',
    'set',
    'delete',
    'where',
  ]) {
    builder[m] = vi.fn(chain);
  }
  builder['returning'] = vi.fn(() => Promise.resolve(results.returning.shift() ?? []));
  builder['execute'] = vi.fn(() => Promise.resolve({ rows: [] }));
  // oxlint-disable-next-line unicorn/no-thenable -- the builder must be awaitable to mimic Drizzle.
  builder['then'] = (resolve: (v: Row[]) => unknown) => resolve(results.select.shift() ?? []);
  return builder;
}

export function makeDrizzle(results: { select?: Row[][]; returning?: Row[][] } = {}) {
  const state = { select: results.select ?? [], returning: results.returning ?? [] };
  const builder = makeQueryBuilder(state);
  const db = {
    ...builder,
    transaction: vi.fn(async (fn: (txn: unknown) => Promise<unknown>) => fn(builder)),
  };
  return mockDb(db);
}

export const makeEvents = (): { emit: Mock; on: Mock; emitInTransaction: Mock } => ({
  emit: vi.fn(),
  on: vi.fn(),
  emitInTransaction: vi.fn(),
});

export const makePayment = (): { processDeposit: Mock; processWithdrawal: Mock } => ({
  processDeposit: vi.fn().mockResolvedValue({ externalId: 'ext-1', status: 'completed' }),
  processWithdrawal: vi.fn().mockResolvedValue({ externalId: 'ext-2', status: 'completed' }),
});
