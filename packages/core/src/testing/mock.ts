import { vi, type Mock } from 'vitest';
import { ORPCError } from '@orpc/server';
import type {
  AdminCaller,
  AdminGuard,
  DrizzleService,
  EventBus,
  OssContext,
} from '@openora/core/server';
import type { AuditWritePort, ClientMeta } from '@openora/core/contracts';

// The one sanctioned home for test-double type assertions. A unit test standing in
// for a collaborator is inherently partial, so the cast lives here - documented and
// in one place - instead of scattered `as unknown as` across every test body.
// See conventions: "Never cast" - test doubles are the single allowed exception,
// funnelled through these helpers.

/** Build a typed test double from a partial shape. */
export const mock = <T>(partial: object = {}): T => partial as unknown as T;

export const NO_CLIENT_META: ClientMeta = { ip: null, userAgent: null };

export const adminCaller = (over: Partial<AdminCaller> = {}): AdminCaller => ({
  userId: 'admin-1',
  role: 'admin',
  ...NO_CLIENT_META,
  ...over,
});

export const testContext = (over: Partial<OssContext> = {}): OssContext => ({
  request: { headers: {} },
  clientMeta: NO_CLIENT_META,
  ...over,
});

type Row = Record<string, unknown>;

const CHAIN_METHODS = [
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
] as const;

/** Chainable, awaitable Drizzle double: awaiting the builder pops the next `select` queue
 * entry, `.returning()` pops the `returning` queue - a test supplies per-statement results
 * in call order. */
const makeQueryBuilder = (results: { select: Row[][]; returning: Row[][]; execute: Row[][] }) => {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const m of CHAIN_METHODS) {
    builder[m] = vi.fn(chain);
  }
  builder['returning'] = vi.fn(() => Promise.resolve(results.returning.shift() ?? []));
  builder['execute'] = vi.fn(() => Promise.resolve({ rows: results.execute?.shift() ?? [] }));
  // oxlint-disable-next-line unicorn/no-thenable -- the builder must be awaitable to mimic Drizzle.
  builder['then'] = (resolve: (v: Row[]) => unknown) => resolve(results.select.shift() ?? []);
  return builder;
};

/** Fake `DrizzleService` for tests asserting call order/shape rather than committed state -
 * reach for `createTestDb` when a real unique index, lock or transaction outcome matters. */
export const makeDrizzle = (
  results: { select?: Row[][]; returning?: Row[][]; execute?: Row[][] } = {},
) => {
  const state = {
    select: results.select ?? [],
    returning: results.returning ?? [],
    execute: results.execute ?? [],
  };
  const builder = makeQueryBuilder(state);
  const db = {
    ...builder,
    transaction: vi.fn(async (fn: (txn: unknown) => Promise<unknown>) => fn(builder)),
  };
  return { db } as unknown as DrizzleService;
};

type MockedEventBus = EventBus & { emit: Mock; on: Mock; emitInTransaction: Mock };

/**
 * EventBus double whose three methods are vitest mocks, so a test can both pass it
 * to a service and assert on `events.emit` without a second `mock<EventBus>()` wrap.
 */
export const makeEventBus = (): MockedEventBus =>
  mock<MockedEventBus>({ emit: vi.fn(), on: vi.fn(), emitInTransaction: vi.fn() });

export const makeAuditWriter = (): AuditWritePort & { record: Mock } => ({
  record: vi.fn(async () => undefined),
  recordInTransaction: vi.fn(async () => undefined),
});

const matches = (refs: readonly string[], resource: string, action: string) =>
  refs.includes(resource) || refs.includes(`${resource}:${action}`);

const isPermitted = (
  options: { allow?: readonly string[]; deny?: readonly string[] },
  resource: string,
  action: string,
) =>
  options.allow
    ? matches(options.allow, resource, action)
    : !matches(options.deny ?? [], resource, action);

/**
 * AdminGuard double driven by permission lists rather than a hand-rolled `assert`.
 *
 * Pass `allow` for an allowlist (anything unlisted throws FORBIDDEN, so `allow: []`
 * denies every guarded route) or `deny` for a denylist. Each entry is a bare
 * resource (`'admin'`, matching any action on it) or a full `resource:action`.
 * With neither list every check passes. An unguarded `assert(ctx)` - no resource -
 * always passes, mirroring the real guard's plain admin check.
 */
export const makeAdminGuard = (
  options: {
    allow?: readonly string[];
    deny?: readonly string[];
    caller?: Partial<AdminCaller>;
  } = {},
): AdminGuard =>
  mock<AdminGuard>({
    assert: vi.fn(async (_ctx: unknown, resource?: string, action?: string) => {
      if (resource && action && !isPermitted(options, resource, action)) {
        throw new ORPCError('FORBIDDEN', { message: `Missing permission: ${resource}:${action}` });
      }
      return adminCaller(options.caller);
    }),
  });
