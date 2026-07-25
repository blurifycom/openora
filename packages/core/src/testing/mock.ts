import { vi, type Mock } from 'vitest';
import { ORPCError } from '@orpc/server';
import type { AdminCaller, AdminGuard, EventBus, OssContext } from '@openora/core/server';
import type { AuditWritePort, ClientMeta } from '@openora/core/contracts';

// The one sanctioned home for test-double type assertions. A unit test standing in
// for a collaborator is inherently partial, so the cast lives here - documented and
// in one place - instead of scattered `as unknown as` across every test body.
// See conventions: "Never cast" - test doubles are the single allowed exception,
// funnelled through these helpers.

/** Build a typed test double from a partial shape. */
export const mock = <T>(partial: object = {}): T => partial as unknown as T;

export const NO_CLIENT_META: ClientMeta = { ip: null, userAgent: null };

const adminCaller = (over: Partial<AdminCaller> = {}): AdminCaller => ({
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

type MockedEventBus = EventBus & { emit: Mock; on: Mock; emitInTransaction: Mock };

/**
 * EventBus double whose three methods are vitest mocks, so a test can both pass it
 * to a service and assert on `events.emit` without a second `mock<EventBus>()` wrap.
 */
export const makeEventBus = (): MockedEventBus =>
  mock<MockedEventBus>({ emit: vi.fn(), on: vi.fn(), emitInTransaction: vi.fn() });

export const makeAuditWriter = (): AuditWritePort & { record: Mock } => ({
  record: vi.fn(async () => undefined),
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
