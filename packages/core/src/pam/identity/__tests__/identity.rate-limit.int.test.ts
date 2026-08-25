import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { RedisRateLimiter } from '@openora/core/server';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import type {
  EmailTemplateRenderer,
  IdentityReader,
  PlayerProvisioning,
  RateLimiterAdapter,
} from '@openora/core/contracts';
import { definePlatformConfig } from '@openora/core/contracts';
import { makeIdentityReader, mock, makeEventBus } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { IdentityService, type IdentityServiceDeps } from '../service/identity.service.js';

const testTemplateRenderer: EmailTemplateRenderer = {
  render: () => ({ subject: 'subject', body: 'body' }),
};

function withTemplateRenderer(
  deps: Omit<IdentityServiceDeps, 'templateRenderer' | 'identityReader'> & {
    identityReader?: IdentityReader;
  },
) {
  return new IdentityService({
    templateRenderer: testTemplateRenderer,
    playerProvisioning: mock<PlayerProvisioning>({ createForRegistration: vi.fn() }),
    ...deps,
    identityReader: deps.identityReader ?? makeIdentityReader(),
  });
}

// Keep the real @openora/core/server (so assertRateLimit + RedisRateLimiter are real); only
// stub createAuth so the constructor doesn't touch a real DB.
vi.mock('@openora/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openora/core/server')>();
  return {
    ...actual,
    createAuth: vi.fn(() => ({
      api: { getSession: vi.fn().mockResolvedValue(null), signUpEmail: vi.fn() },
    })),
  };
});

const events = makeEventBus();

let db: TestDb;
let drizzle: IdentityServiceDeps['drizzle'];
let redis: TestRedis;
const makeLimiter = () => new RedisRateLimiter(redis.client);

beforeAll(async () => {
  db = await createTestDb([migrate]);
  drizzle = db.drizzle;
  redis = await createTestRedis();
});

afterAll(async () => {
  await db.drop();
  await redis.quit();
});

beforeEach(async () => {
  await redis.flush();
});

describe('IdentityService - rate limiting (real Redis)', () => {
  it('rejects register with a 429 once the per-email limit is exhausted', async () => {
    const email = 'abuse@x.dev';
    const limiter = makeLimiter();
    // Pre-exhaust the register bucket (5 per 15min) so the service's own consume is denied.
    for (let i = 0; i < 5; i++) {
      await limiter.consume(`register:${email}`, { limit: 5, windowMs: 15 * 60 * 1000 });
    }
    const svc = withTemplateRenderer({
      drizzle,
      events,
      limiter,
      platformConfig: definePlatformConfig({
        registration: { termsVersion: '2026-08', requireEmailVerification: false },
      }),
    });

    await expect(
      svc.register(
        {
          email,
          password: 'password123',
          username: 'alpha',
          acceptedTerms: true,
          acceptedAge: true,
        },
        {},
      ),
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      data: { retryAfterMs: expect.any(Number) },
    });
  });

  it('allows register when no limiter is bound (test/no-auth edition)', async () => {
    const svc = withTemplateRenderer({ drizzle, events });
    // signUpEmail is a bare vi.fn returning undefined; a throw here would be a 429, not the
    // downstream .json() failure we expect, so assert we got past the guard.
    await expect(
      svc.register(
        {
          email: 'ok@x.dev',
          password: 'password123',
          username: 'alpha',
          acceptedTerms: true,
          acceptedAge: true,
        },
        {},
      ),
    ).rejects.not.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });
});

describe('IdentityService - verify2fa rate-limit key stability (ABC-208 finding #3)', () => {
  it('keys on the two_factor cookie VALUE, not the raw Cookie header, so junk cookie pairs cannot churn the bucket', async () => {
    const limiter = makeLimiter();
    const twoFactorIdentifier = 'pending-2fa-identifier-abc';
    for (let i = 0; i < 5; i++) {
      await limiter.consume(`verify2fa:${twoFactorIdentifier}`, {
        limit: 5,
        windowMs: 5 * 60 * 1000,
      });
    }
    const svc = withTemplateRenderer({ drizzle, events, limiter });

    // Same two_factor cookie + different junk pairs must still hit the one exhausted bucket.
    for (let i = 0; i < 3; i++) {
      await expect(
        svc.verifyTwoFactor(
          { code: '123456', trustDevice: false },
          { cookie: `better-auth.two_factor=${twoFactorIdentifier}; junk${i}=${i}` },
          new Headers(),
        ),
      ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    }
  });
});

describe('IdentityService - rate limiting on secret-guessing routes (ABC-208 finding #6)', () => {
  it('rejects changePassword with a 429 once the per-caller limit is exhausted', async () => {
    const limiter = makeLimiter();
    for (let i = 0; i < 5; i++) {
      await limiter.consume('change-password:anonymous', { limit: 5, windowMs: 15 * 60 * 1000 });
    }
    const svc = withTemplateRenderer({ drizzle, events, limiter });

    await expect(
      svc.changePassword(
        { currentPassword: 'currentpw1', newPassword: 'newpassword1' },
        {},
        new Headers(),
      ),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('rejects verifyEmail with a 429 once the per-address limit is exhausted', async () => {
    const limiter = makeLimiter();
    for (let i = 0; i < 5; i++) {
      await limiter.consume('verify-email:target@e2e.test', { limit: 5, windowMs: 15 * 60 * 1000 });
    }
    const svc = withTemplateRenderer({ drizzle, events, limiter });

    // Six digits are guessable, so the budget follows the address under attack.
    await expect(
      svc.verifyEmail(
        { email: 'target@e2e.test', otp: '000000' },
        { 'x-real-ip': '203.0.113.5' },
        new Headers(),
      ),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('buckets verifyEmail addresses separately, so one target cannot stall the rest', async () => {
    const limiter = makeLimiter();
    for (let i = 0; i < 5; i++) {
      await limiter.consume('verify-email:target@e2e.test', { limit: 5, windowMs: 15 * 60 * 1000 });
    }
    const svc = withTemplateRenderer({ drizzle, events, limiter });

    // Codes are entered without a session. A shared bucket would let the exhausted
    // address above block every other sign-up in flight.
    await expect(
      svc.verifyEmail(
        { email: 'other@e2e.test', otp: '000000' },
        { 'x-real-ip': '203.0.113.7' },
        new Headers(),
      ),
    ).rejects.not.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('rejects enableTwoFactor with a 429 once the per-caller limit is exhausted', async () => {
    const limiter = makeLimiter();
    for (let i = 0; i < 5; i++) {
      await limiter.consume('enable2fa:anonymous', { limit: 5, windowMs: 5 * 60 * 1000 });
    }
    const svc = withTemplateRenderer({ drizzle, events, limiter });

    await expect(
      svc.enableTwoFactor({ password: 'currentpw1' }, {}, new Headers()),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('rejects disableTwoFactor with a 429 once the per-caller limit is exhausted', async () => {
    const limiter = makeLimiter();
    for (let i = 0; i < 5; i++) {
      await limiter.consume('disable2fa:anonymous', { limit: 5, windowMs: 5 * 60 * 1000 });
    }
    const svc = withTemplateRenderer({ drizzle, events, limiter });

    await expect(
      svc.disableTwoFactor({ password: 'currentpw1' }, {}, new Headers()),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });
});

describe('IdentityService - fail-closed limiter policy for credential-guessing keys', () => {
  // A spy limiter that always denies: consume is the first await on each of these
  // paths, so the 429 short-circuits before any auth/DB work and we can assert the
  // exact options the service passed for the key. (The RedisRateLimiter's own
  // fail-closed behaviour is covered in the kernel redis-rate-limiter suite.)
  function denyingLimiter() {
    const consume = vi.fn(async () => ({ allowed: false, retryAfterMs: 1 }));
    return { limiter: mock<RateLimiterAdapter>({ consume }), consume };
  }

  it('passes onUnavailable: deny on the login: key', async () => {
    const { limiter, consume } = denyingLimiter();
    const svc = withTemplateRenderer({ drizzle, events, limiter });

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
    const svc = withTemplateRenderer({ drizzle, events, limiter });

    await expect(
      svc.verifyTwoFactor({ code: '123456', trustDevice: false }, {}, new Headers()),
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(consume).toHaveBeenCalledWith(
      expect.stringMatching(/^verify2fa:/),
      expect.objectContaining({ onUnavailable: 'deny' }),
    );
  });

  it('passes onUnavailable: deny on the pwreset: key', async () => {
    const { limiter, consume } = denyingLimiter();
    const svc = withTemplateRenderer({ drizzle, events, limiter });

    await expect(
      svc.resetPassword({ email: 'user@x.dev', otp: '123456', newPassword: 'newpassword1' }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(consume).toHaveBeenCalledWith(
      'pwreset:user@x.dev',
      expect.objectContaining({ onUnavailable: 'deny' }),
    );
  });

  it('passes onUnavailable: deny on the pwreset-verify: key', async () => {
    const { limiter, consume } = denyingLimiter();
    const svc = withTemplateRenderer({ drizzle, events, limiter });

    await expect(
      svc.verifyPasswordResetOtp({ email: 'user@x.dev', otp: '123456' }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(consume).toHaveBeenCalledWith(
      'pwreset-verify:user@x.dev',
      expect.objectContaining({ onUnavailable: 'deny' }),
    );
  });

  it('throttles requestPasswordReset on the pwreset-req: key', async () => {
    const { limiter, consume } = denyingLimiter();
    const svc = withTemplateRenderer({ drizzle, events, limiter });

    // The throttle is asserted before the anti-enumeration try/catch, so a denied
    // request key surfaces as a 429 (only the better-auth call is swallowed).
    await expect(svc.requestPasswordReset({ email: 'User@X.dev' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(consume).toHaveBeenCalledWith('pwreset-req:user@x.dev', expect.any(Object));
  });
});
