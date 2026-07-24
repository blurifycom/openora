import { vi, type Mock } from 'vitest';
import type { AdminCaller, OssContext } from '@openora/core/server';
import type { ClientMeta } from '@openora/core/contracts';

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

export const makeEvents = (): { emit: Mock; on: Mock; emitInTransaction: Mock } => ({
  emit: vi.fn(),
  on: vi.fn(),
  emitInTransaction: vi.fn(),
});
