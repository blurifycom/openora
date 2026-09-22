import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { RedisRateLimiter } from '@openora/core/server';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import type { GeoCheckCommands, PlayerProvisioning, SmsAdapter } from '@openora/core/contracts';
import { definePlatformConfig } from '@openora/core/contracts';
import { makeIdentityReader, mock, makeEventBus } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { IdentityService, type IdentityServiceDeps } from '../service/identity.service.js';
import { TwoFactorDeliveryService } from '../service/two-factor-delivery.service.js';

const authApi = vi.hoisted(() => ({
  getSession: vi.fn().mockResolvedValue(null),
  signUpEmail: vi.fn(),
  signInEmail: vi.fn(),
}));

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

describe('IdentityService.login - country access gate', () => {
  const credentials = { email: 'player@x.dev', password: 'password1234' };
  const headers = { 'x-real-ip': '203.0.113.7' };

  it('refuses a login from a geo-blocked address and audits the attempt', async () => {
    const checkAccess = vi.fn().mockResolvedValue({ allowed: false, countryCode: 'US' });
    const svc = makeService({ geoCheck: mock<GeoCheckCommands>({ checkAccess }) });

    await expect(svc.login(credentials, headers, new Headers())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(checkAccess).toHaveBeenCalledWith('203.0.113.7');
    expect(loginFailures()).toEqual([
      expect.objectContaining({ reason: 'geo_blocked', countryCode: 'US', ip: '203.0.113.7' }),
    ]);
  });

  it('refuses before the credentials are ever presented', async () => {
    const checkAccess = vi.fn().mockResolvedValue({ allowed: false, countryCode: 'US' });
    const svc = makeService({ geoCheck: mock<GeoCheckCommands>({ checkAccess }) });

    await expect(svc.login(credentials, headers, new Headers())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(authApi.signInEmail).not.toHaveBeenCalled();
  });

  it('lets an allowed country reach the credential check', async () => {
    const checkAccess = vi.fn().mockResolvedValue({ allowed: true, countryCode: 'DE' });
    const svc = makeService({ geoCheck: mock<GeoCheckCommands>({ checkAccess }) });
    authApi.signInEmail.mockRejectedValueOnce(new Error('auth stub'));

    await expect(svc.login(credentials, headers, new Headers())).rejects.toThrow();
    expect(authApi.signInEmail).toHaveBeenCalled();
    expect(loginFailures().map((failure) => failure.reason)).not.toContain('geo_blocked');
  });

  it('lets a login through when no geo-check port is bound', async () => {
    const svc = makeService();
    authApi.signInEmail.mockRejectedValueOnce(new Error('auth stub'));

    await expect(svc.login(credentials, headers, new Headers())).rejects.toThrow();
    expect(authApi.signInEmail).toHaveBeenCalled();
  });
});
