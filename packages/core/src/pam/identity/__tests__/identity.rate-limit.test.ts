import { describe, it, expect, vi } from 'vitest';
import { InProcessRateLimiter, type EventBus } from '@openora/core/server';
import type { RateLimiterAdapter } from '@openora/core/contracts';
import { mock, mockDb } from '../../../testing/mock.js';
import { IdentityService } from '../service/identity.service.js';

// Keep the real @openora/core/server (so assertRateLimit + InProcessRateLimiter
// are real); only stub createAuth so the constructor doesn't touch a real DB.
vi.mock('@openora/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openora/core/server')>();
  return {
    ...actual,
    createAuth: vi.fn(() => ({
      api: { getSession: vi.fn().mockResolvedValue(null), signUpEmail: vi.fn() },
    })),
  };
});

const drizzle = mockDb({});
const events = mock<EventBus>({ emit: vi.fn(), on: vi.fn() });

describe('IdentityService - rate limiting', () => {
  it('rejects register with a 429 once the per-email limit is exhausted', async () => {
    const email = 'abuse@x.dev';
    const limiter = new InProcessRateLimiter();
    // Pre-exhaust the register bucket (5 per 15min) so the service's own consume is denied.
    for (let i = 0; i < 5; i++) {
      await limiter.consume(`register:${email}`, { limit: 5, windowMs: 15 * 60 * 1000 });
    }
    const svc = new IdentityService({ drizzle, events, limiter });

    await expect(
      svc.register({ email, password: 'password123', name: 'A' }, {}, new Headers()),
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      data: { retryAfterMs: expect.any(Number) },
    });
    limiter.close();
  });

  it('allows register when no limiter is bound (test/no-auth edition)', async () => {
    const svc = new IdentityService({ drizzle, events });
    // signUpEmail is a bare vi.fn returning undefined; a throw here would be a 429, not the
    // downstream .json() failure we expect, so assert we got past the guard.
    await expect(
      svc.register({ email: 'ok@x.dev', password: 'password123', name: 'A' }, {}, new Headers()),
    ).rejects.not.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });
});

describe('IdentityService - verify2fa rate-limit key stability (ABC-208 finding #3)', () => {
  it('keys on the two_factor cookie VALUE, not the raw Cookie header, so junk cookie pairs cannot churn the bucket', async () => {
    const limiter = new InProcessRateLimiter();
    const twoFactorIdentifier = 'pending-2fa-identifier-abc';
    for (let i = 0; i < 5; i++) {
      await limiter.consume(`verify2fa:${twoFactorIdentifier}`, {
        limit: 5,
        windowMs: 5 * 60 * 1000,
      });
    }
    const svc = new IdentityService({ drizzle, events, limiter });

    // Same two_factor cookie + different junk pairs must still hit the one exhausted bucket.
    for (let i = 0; i < 3; i++) {
      await expect(
        svc.verifyTwoFactor(
          { code: '123456' },
          { cookie: `better-auth.two_factor=${twoFactorIdentifier}; junk${i}=${i}` },
          new Headers(),
        ),
      ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    }
    limiter.close();
  });
});

describe('IdentityService - rate limiting on secret-guessing routes (ABC-208 finding #6)', () => {
  it('rejects changePassword with a 429 once the per-caller limit is exhausted', async () => {
    const limiter = new InProcessRateLimiter();
    for (let i = 0; i < 5; i++) {
      await limiter.consume('change-password:anonymous', { limit: 5, windowMs: 15 * 60 * 1000 });
    }
    const svc = new IdentityService({ drizzle, events, limiter });

    await expect(
      svc.changePassword(
        { currentPassword: 'currentpw1', newPassword: 'newpassword1' },
        {},
        new Headers(),
      ),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    limiter.close();
  });

  it('rejects verifyEmail with a 429 once the per-caller limit is exhausted', async () => {
    const limiter = new InProcessRateLimiter();
    for (let i = 0; i < 5; i++) {
      await limiter.consume('verify-email:anonymous', { limit: 5, windowMs: 15 * 60 * 1000 });
    }
    const svc = new IdentityService({ drizzle, events, limiter });

    await expect(svc.verifyEmail({ token: 'sometoken' }, {})).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    limiter.close();
  });

  it('rejects enableTwoFactor with a 429 once the per-caller limit is exhausted', async () => {
    const limiter = new InProcessRateLimiter();
    for (let i = 0; i < 5; i++) {
      await limiter.consume('enable2fa:anonymous', { limit: 5, windowMs: 5 * 60 * 1000 });
    }
    const svc = new IdentityService({ drizzle, events, limiter });

    await expect(
      svc.enableTwoFactor({ password: 'currentpw1' }, {}, new Headers()),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    limiter.close();
  });

  it('rejects disableTwoFactor with a 429 once the per-caller limit is exhausted', async () => {
    const limiter = new InProcessRateLimiter();
    for (let i = 0; i < 5; i++) {
      await limiter.consume('disable2fa:anonymous', { limit: 5, windowMs: 5 * 60 * 1000 });
    }
    const svc = new IdentityService({ drizzle, events, limiter });

    await expect(
      svc.disableTwoFactor({ password: 'currentpw1' }, {}, new Headers()),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    limiter.close();
  });
});

describe('IdentityService - fail-closed limiter policy for credential-guessing keys', () => {
  // A spy limiter that always denies: consume is the first await on each of these
  // paths, so the 429 short-circuits before any auth/DB work and we can assert the
  // exact options the service passed for the key.
  function denyingLimiter() {
    const consume = vi.fn(async () => ({ allowed: false, retryAfterMs: 1 }));
    return { limiter: mock<RateLimiterAdapter>({ consume }), consume };
  }

  it('passes onUnavailable: deny on the login: key', async () => {
    const { limiter, consume } = denyingLimiter();
    const svc = new IdentityService({ drizzle, events, limiter });

    await expect(
      svc.login({ email: 'User@X.dev', password: 'password123' }, {}, new Headers()),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(consume).toHaveBeenCalledWith(
      'login:user@x.dev',
      expect.objectContaining({ onUnavailable: 'deny' }),
    );
  });

  it('passes onUnavailable: deny on the verify2fa: key', async () => {
    const { limiter, consume } = denyingLimiter();
    const svc = new IdentityService({ drizzle, events, limiter });

    await expect(svc.verifyTwoFactor({ code: '123456' }, {}, new Headers())).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(consume).toHaveBeenCalledWith(
      expect.stringMatching(/^verify2fa:/),
      expect.objectContaining({ onUnavailable: 'deny' }),
    );
  });

  it('passes onUnavailable: deny on the pwreset: key', async () => {
    const { limiter, consume } = denyingLimiter();
    const svc = new IdentityService({ drizzle, events, limiter });

    await expect(
      svc.resetPassword({ email: 'user@x.dev', otp: '123456', newPassword: 'newpassword1' }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(consume).toHaveBeenCalledWith(
      'pwreset:user@x.dev',
      expect.objectContaining({ onUnavailable: 'deny' }),
    );
  });
});
