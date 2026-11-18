import { describe, it, expect, vi } from 'vitest';
import { ORPCError } from '@orpc/server';
import { ADMIN_SECURITY_ROUTE, AdminSecurityWire } from '@openora/core/contracts';
import { InternalApiError, type InternalClient } from '@openora/core/server';
import { RemoteAdminSecurityPolicy } from '../service/remote-admin-security.service.js';

const caller = {
  userId: 'user-1',
  sessionId: 'session-1',
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0 test',
};

function policyAnswering(answer: () => unknown) {
  const request = vi.fn<InternalClient['request']>(async () => answer());
  return { request, policy: new RemoteAdminSecurityPolicy({ request }) };
}

const refusal = (err: unknown) => err as ORPCError<string, { reason?: string }>;

describe('RemoteAdminSecurityPolicy', () => {
  it('sends the check and the caller, address and device included, and passes on a clean verdict', async () => {
    const { request, policy } = policyAnswering(() => ({ refusal: null }));

    await policy.assertEnrolled(caller);
    await policy.assertSessionIntact(caller);

    expect(request.mock.calls.map(([method, path]) => [method, path])).toEqual([
      ['POST', ADMIN_SECURITY_ROUTE],
      ['POST', ADMIN_SECURITY_ROUTE],
    ]);
    const bodies = request.mock.calls.map(([, , body]) => AdminSecurityWire.input.parse(body));
    expect(bodies).toEqual([
      { check: 'enrolled', ...caller },
      { check: 'session_intact', ...caller },
    ]);
  });

  it('never caches: every check asks identity again', async () => {
    const { request, policy } = policyAnswering(() => ({ refusal: null }));

    await policy.assertSessionIntact(caller);
    await policy.assertSessionIntact(caller);

    expect(request).toHaveBeenCalledTimes(2);
  });

  it('throws the refusal identity answered with, status and reason intact', async () => {
    const { policy } = policyAnswering(() => ({
      refusal: {
        code: 'UNAUTHORIZED',
        message: 'Session ended because the device or network changed',
        reason: 'session_fingerprint_mismatch',
      },
    }));

    const err = refusal(await policy.assertSessionIntact(caller).catch((e: unknown) => e));

    expect(err).toBeInstanceOf(ORPCError);
    expect([err.code, err.message, err.data?.reason]).toEqual([
      'UNAUTHORIZED',
      'Session ended because the device or network changed',
      'session_fingerprint_mismatch',
    ]);
  });

  it('answers 503 when identity cannot be reached', async () => {
    for (const kind of ['timeout', 'network', 'server'] as const) {
      const { policy } = policyAnswering(() => {
        throw new InternalApiError(kind, 'down');
      });

      expect(refusal(await policy.assertEnrolled(caller).catch((e: unknown) => e)).code).toBe(
        'SERVICE_UNAVAILABLE',
      );
    }
  });

  it('refuses, and never passes, a call identity rejected or answered unreadably', async () => {
    const rejected = policyAnswering(() => {
      throw new InternalApiError('client', 'refused', { status: 403 });
    });
    const unreadable = policyAnswering(() => ({ verdict: 'ok' }));

    await expect(rejected.policy.assertEnrolled(caller)).rejects.toBeInstanceOf(InternalApiError);
    await expect(unreadable.policy.assertEnrolled(caller)).rejects.toThrow();
  });
});
