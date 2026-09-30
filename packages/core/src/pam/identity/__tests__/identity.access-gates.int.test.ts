import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { RedisRateLimiter } from '@openora/core/server';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import type { GeoCheckCommands, PlayerProvisioning, SmsAdapter } from '@openora/core/contracts';
import { definePlatformConfig } from '@openora/core/contracts';
import { makeIdentityReader, mock, makeEventBus } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { IdentityService, type IdentityServiceDeps } from '../service/identity.service.js';
import { TwoFactorDeliveryService } from '../service/two-factor-delivery.service.js';
import { assertCountryAllowed } from '../service/rg-guard.service.js';

const authApi = vi.hoisted(() => ({
  getSession: vi.fn().mockResolvedValue(null),
  signUpEmail: vi.fn(),
  signInEmail: vi.fn(),
  verifyEmailOTP: vi.fn(),
}));
import { UsernameBlockedError } from '../../shared/username.js';

vi.mock('@openora/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openora/core/server')>();
  return { ...actual, createAuth: vi.fn(() => ({ api: authApi })) };
});

const events = makeEventBus();
const registrationConfig = definePlatformConfig({
  registration: { termsVersion: 'test-v1', requireEmailVerification: false },
});

let db: TestDb;
let drizzle: IdentityServiceDeps['drizzle'];
let redis: TestRedis;

const validInput = () => ({
  email: `gate-${Math.random().toString(36).slice(2)}@x.dev`,
  password: 'password1234',
  username: 'alpha',
  acceptedTerms: true as const,
  acceptedAge: true as const,
});

function makeService(overrides: Partial<IdentityServiceDeps> = {}) {
  return new IdentityService({
    drizzle,
    events,
    identityReader: makeIdentityReader(),
    platformConfig: registrationConfig,
    playerProvisioning: mock<PlayerProvisioning>({
      createForRegistration: vi.fn().mockResolvedValue({ created: true }),
    }),
    twoFactorDelivery: new TwoFactorDeliveryService({
      drizzle,
      sms: mock<SmsAdapter>({ sendOtp: vi.fn() }),
    }),
    ...overrides,
  });
}

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
  events.emit.mockClear();
  authApi.signInEmail.mockReset();
  authApi.verifyEmailOTP.mockReset();
});

const failureReasons = () =>
  events.emit.mock.calls
    .filter(([topic]) => topic === 'identity.user.registration.failed')
    .map(([, payload]) => (payload as { reason: string }).reason);

const loginFailures = () =>
  events.emit.mock.calls
    .filter(([topic]) => topic === 'identity.user.login.failed')
    .map(([, payload]) => payload as { reason: string; ip: string | null; countryCode?: string });

describe('IdentityService.register - availability gates', () => {
  it('rejects registration when the operator has not configured it', async () => {
    const svc = makeService({ platformConfig: undefined });

    await expect(svc.register(validInput(), {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(failureReasons()).toEqual(['registration_disabled']);
  });

  it('rejects registration when no player provisioning port is bound', async () => {
    const svc = makeService({ playerProvisioning: undefined });

    await expect(svc.register(validInput(), {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('rejects registration from a geo-blocked address', async () => {
    const checkAccess = vi.fn().mockResolvedValue({ allowed: false });
    const svc = makeService({ geoCheck: mock<GeoCheckCommands>({ checkAccess }) });

    await expect(svc.register(validInput(), { 'x-real-ip': '203.0.113.7' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(checkAccess).toHaveBeenCalledWith('203.0.113.7');
    expect(failureReasons()).toEqual(['geo_blocked']);
  });

  it('throttles registrations coming from one address, across different emails', async () => {
    const svc = makeService({ limiter: new RedisRateLimiter(redis.client) });
    const headers = { 'x-real-ip': '203.0.113.9' };

    // Each call uses a fresh email, so only the per-IP bucket can reject them. The
    // early attempts fail downstream on the stubbed auth call - that is fine, the
    // limiter is consumed before that happens.
    for (let i = 0; i < 5; i++) {
      await svc.register(validInput(), headers).catch(() => undefined);
    }

    await expect(svc.register(validInput(), headers)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(failureReasons()).toContain('rate_limited');
  });

  // Every attempt has to leave a record with its origin, not only the ones that produce
  // an account. A rejected attempt is unauthenticated, so the address is the only subject
  // there is to record it against.
  it('records the origin of a rejected attempt, since there is no account to attribute it to', async () => {
    const svc = makeService({ platformConfig: undefined });
    const input = validInput();

    await svc
      .register(input, { 'x-real-ip': '203.0.113.7', 'user-agent': 'Mozilla/5.0' })
      .catch(() => undefined);

    expect(events.emit).toHaveBeenCalledWith('identity.user.registration.failed', {
      email: input.email,
      username: input.username,
      reason: 'registration_disabled',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });
  });
});

const signedIn = () =>
  new Response(
    JSON.stringify({
      token: 'minted-session-token',
      user: {
        id: '00000000-0000-0000-0000-0000000000a1',
        email: 'player@x.dev',
        name: 'Player',
        emailVerified: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const blockedGeo = () =>
  mock<GeoCheckCommands>({
    checkAccess: vi.fn().mockResolvedValue({ allowed: false, countryCode: 'US' }),
  });

describe('IdentityService.login - country access gate', () => {
  const credentials = { email: 'player@x.dev', password: 'password1234' };
  const headers = { 'x-real-ip': '203.0.113.7' };

  it('refuses a proven login from a geo-blocked address and records why', async () => {
    const geoCheck = blockedGeo();
    const svc = makeService({ geoCheck });
    authApi.signInEmail.mockResolvedValueOnce(signedIn());
    const resHeaders = new Headers();

    await expect(svc.login(credentials, headers, resHeaders)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      data: { code: 'GEO_BLOCKED' },
    });
    expect(geoCheck.checkAccess).toHaveBeenCalledWith('203.0.113.7');
    expect(resHeaders.get('set-cookie')).toBeNull();
    expect(loginFailures()).toEqual([
      expect.objectContaining({ reason: 'geo_blocked', countryCode: 'US', ip: '203.0.113.7' }),
    ]);
  });

  it('leaves a wrong password to the credential check, not the country rule', async () => {
    const geoCheck = blockedGeo();
    const svc = makeService({ geoCheck });
    authApi.signInEmail.mockRejectedValueOnce(new Error('auth stub'));

    await expect(svc.login(credentials, headers, new Headers())).rejects.toThrow();
    expect(geoCheck.checkAccess).not.toHaveBeenCalled();
    expect(loginFailures().map((failure) => failure.reason)).not.toContain('geo_blocked');
  });

  it('lets a login through when no geo-check port is bound', async () => {
    const svc = makeService();
    authApi.signInEmail.mockRejectedValueOnce(new Error('auth stub'));

    await expect(svc.login(credentials, headers, new Headers())).rejects.toThrow();
    expect(authApi.signInEmail).toHaveBeenCalled();
  });
});

describe('IdentityService.verifyEmail - country access gate', () => {
  it('refuses the session an emailed code mints from a geo-blocked address', async () => {
    const geoCheck = blockedGeo();
    const svc = makeService({ geoCheck });
    authApi.verifyEmailOTP.mockResolvedValueOnce(signedIn());
    const resHeaders = new Headers();

    await expect(
      svc.verifyEmail(
        { email: 'player@x.dev', otp: '123456' },
        { 'x-real-ip': '203.0.113.7' },
        resHeaders,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', data: { code: 'GEO_BLOCKED' } });
    expect(geoCheck.checkAccess).toHaveBeenCalledWith('203.0.113.7');
    expect(resHeaders.get('set-cookie')).toBeNull();
  });
});

describe('assertCountryAllowed', () => {
  it('exempts staff, so a blocked country cannot lock operators out of the backoffice', async () => {
    const geoCheck = blockedGeo();

    await expect(
      assertCountryAllowed(geoCheck, { role: 'admin' }, '203.0.113.7'),
    ).resolves.toBeUndefined();
    expect(geoCheck.checkAccess).not.toHaveBeenCalled();
  });

  it('runs the caller cleanup before refusing a player', async () => {
    const onDenied = vi.fn();

    await expect(
      assertCountryAllowed(blockedGeo(), { role: 'player' }, '203.0.113.7', onDenied),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', data: { code: 'GEO_BLOCKED' } });
    expect(onDenied).toHaveBeenCalledWith('US');
  });
});

describe('IdentityService.register - username screening', () => {
  it.each(['big_ass', 'support_1', 'acmebet_vip'])(
    'refuses %s before any account is created',
    async (username) => {
      const svc = makeService({
        platformConfig: definePlatformConfig({
          registration: { termsVersion: 'test-v1', requireEmailVerification: false },
          reservedUsernames: ['AcmeBet'],
        }),
      });

      await expect(svc.register({ ...validInput(), username }, {})).rejects.toBeInstanceOf(
        UsernameBlockedError,
      );
      expect(failureReasons()).toEqual(['username_blocked']);
    },
  );

  it('reports a refused handle as unavailable', async () => {
    const svc = makeService();

    await expect(svc.usernameAvailable('real_admin', {})).resolves.toEqual({ available: false });
  });
});
