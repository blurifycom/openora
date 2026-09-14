import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { RedisRateLimiter } from '@openora/core/server';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import type {
  IdentityReader,
  PlayerProvisioning,
  RateLimiterAdapter,
  SmsAdapter,
} from '@openora/core/contracts';
import { definePlatformConfig } from '@openora/core/contracts';
import { makeIdentityReader, mock, makeEventBus } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { IdentityService, type IdentityServiceDeps } from '../service/identity.service.js';
import { TwoFactorDeliveryService } from '../service/two-factor-delivery.service.js';

function withTemplateRenderer(
  deps: Omit<IdentityServiceDeps, 'identityReader' | 'twoFactorDelivery'> & {
    identityReader?: IdentityReader;
    twoFactorDelivery?: IdentityServiceDeps['twoFactorDelivery'];
  },
) {
  return new IdentityService({
    playerProvisioning: mock<PlayerProvisioning>({ createForRegistration: vi.fn() }),
    ...deps,
    identityReader: deps.identityReader ?? makeIdentityReader(),
    twoFactorDelivery:
      deps.twoFactorDelivery ??
      new TwoFactorDeliveryService({
        drizzle: deps.drizzle,
        sms: mock<SmsAdapter>({ sendOtp: vi.fn() }),
      }),
  });
}

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn().mockResolvedValue(null),
}));

const rejectedOtpResponse = () =>
  new Response(JSON.stringify({ message: 'Invalid or expired verification code' }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });

// Keep the real @openora/core/server (so assertRateLimit + RedisRateLimiter are real); only
// stub createAuth so the constructor doesn't touch a real DB.
vi.mock('@openora/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openora/core/server')>();
  return {
    ...actual,
    createAuth: vi.fn(() => ({
      api: {
        getSession: getSessionMock,
        signUpEmail: vi.fn(),
        requestEmailChangeEmailOTP: vi.fn().mockResolvedValue(rejectedOtpResponse()),
        changeEmailEmailOTP: vi.fn().mockResolvedValue(rejectedOtpResponse()),
      },
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
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue(null);
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
          password: 'password1234',
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
          password: 'password1234',
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
          { code: '123456', method: 'totp', trustDevice: false },
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
    const userId = 'rate-limited-user';
    for (let i = 0; i < 5; i++) {
      await limiter.consume(`change-password:${userId}`, { limit: 5, windowMs: 15 * 60 * 1000 });
    }
    const svc = withTemplateRenderer({ drizzle, events, limiter });

    await expect(
      svc.changePassword(
        { currentPassword: 'currentpw1', newPassword: 'newpassword1' },
        {},
        new Headers(),
        { userId, sessionId: 'rate-limited-session' },
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
      svc.enableTwoFactor({ password: 'currentpw1', method: 'app' }, {}, new Headers()),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('rejects disableTwoFactor with a 429 once the per-caller limit is exhausted', async () => {
    const limiter = makeLimiter();
    for (let i = 0; i < 5; i++) {
      await limiter.consume('disable2fa:anonymous', { limit: 5, windowMs: 5 * 60 * 1000 });
    }
    const svc = withTemplateRenderer({ drizzle, events, limiter });

    await expect(
      svc.disableTwoFactor({ password: 'currentpw1', code: '123456' }, {}, new Headers()),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });
});

describe('IdentityService - email-change rate limits do not spend the target/IP budget for an anonymous caller', () => {
  it('requestEmailChange rejects UNAUTHORIZED before touching the target or IP bucket', async () => {
    const limiter = makeLimiter();
    const svc = withTemplateRenderer({ drizzle, events, limiter });
    const newEmail = 'victim-request@e2e.test';

    await expect(
      svc.requestEmailChange(
        { newEmail, currentPassword: 'whatever1' },
        { 'x-real-ip': '203.0.113.20' },
        new Headers(),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    // The real owner's budget for this address and IP must still be fully intact.
    for (let i = 0; i < 3; i++) {
      await expect(
        limiter.consume(`change-email-target:${newEmail}`, { limit: 3, windowMs: 15 * 60 * 1000 }),
      ).resolves.toMatchObject({ allowed: true });
    }
    for (let i = 0; i < 3; i++) {
      await expect(
        limiter.consume('change-email-ip:203.0.113.20', { limit: 3, windowMs: 15 * 60 * 1000 }),
      ).resolves.toMatchObject({ allowed: true });
    }
  });

  it('confirmEmailChange rejects UNAUTHORIZED before touching the target or IP bucket', async () => {
    const limiter = makeLimiter();
    const svc = withTemplateRenderer({ drizzle, events, limiter });
    const newEmail = 'victim-confirm@e2e.test';

    await expect(
      svc.confirmEmailChange(
        { newEmail, otp: '000000' },
        { 'x-real-ip': '203.0.113.21' },
        new Headers(),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    for (let i = 0; i < 5; i++) {
      await expect(
        limiter.consume(`confirm-email-change-target:${newEmail}`, {
          limit: 5,
          windowMs: 15 * 60 * 1000,
        }),
      ).resolves.toMatchObject({ allowed: true });
    }
    for (let i = 0; i < 5; i++) {
      await expect(
        limiter.consume('confirm-email-change-ip:203.0.113.21', {
          limit: 5,
          windowMs: 15 * 60 * 1000,
        }),
      ).resolves.toMatchObject({ allowed: true });
    }
  });
});

describe('IdentityService - email-change target rate limit is bound to the caller, not just the target', () => {
  const attackerId = '00000000-0000-4000-8000-0000000000a1';
  const victimId = '00000000-0000-4000-8000-0000000000b2';

  it('a different signed-in caller spamming a known target does not spend the real requester budget', async () => {
    const limiter = makeLimiter();
    const svc = withTemplateRenderer({ drizzle, events, limiter });
    const targetEmail = 'coveted-request@e2e.test';

    getSessionMock.mockResolvedValue({ user: { id: attackerId } });

    for (let i = 0; i < 3; i++) {
      await expect(
        svc.requestEmailChange(
          { newEmail: targetEmail, currentPassword: 'whatever' },
          {},
          new Headers(),
        ),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }

    getSessionMock.mockResolvedValue({ user: { id: victimId } });
    await expect(
      svc.requestEmailChange(
        { newEmail: targetEmail, currentPassword: 'whatever' },
        {},
        new Headers(),
      ),
    ).rejects.not.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('a different signed-in caller spamming a known confirm target does not spend the real requester budget', async () => {
    const limiter = makeLimiter();
    const svc = withTemplateRenderer({ drizzle, events, limiter });
    const targetEmail = 'coveted-confirm@e2e.test';

    getSessionMock.mockResolvedValue({ user: { id: attackerId } });
    for (let i = 0; i < 5; i++) {
      await expect(
        svc.confirmEmailChange({ newEmail: targetEmail, otp: '000000' }, {}, new Headers()),
      ).rejects.not.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    }

    getSessionMock.mockResolvedValue({ user: { id: victimId } });
    await expect(
      svc.confirmEmailChange({ newEmail: targetEmail, otp: '000000' }, {}, new Headers()),
    ).rejects.not.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
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
      svc.verifyTwoFactor(
        { code: '123456', method: 'totp', trustDevice: false },
        {},
        new Headers(),
      ),
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
