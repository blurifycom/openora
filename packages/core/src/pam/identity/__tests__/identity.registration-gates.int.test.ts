import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { RedisRateLimiter } from '@openora/core/server';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import type { GeoCheckCommands, PlayerProvisioning } from '@openora/core/contracts';
import { definePlatformConfig } from '@openora/core/contracts';
import { makeIdentityReader, mock, makeEventBus } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { IdentityService, type IdentityServiceDeps } from '../service/identity.service.js';

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
const registrationConfig = definePlatformConfig({
  registration: { termsVersion: 'test-v1', requireEmailVerification: false },
});

let db: TestDb;
let drizzle: IdentityServiceDeps['drizzle'];
let redis: TestRedis;

const validInput = () => ({
  email: `gate-${Math.random().toString(36).slice(2)}@x.dev`,
  password: 'password123',
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
});

const failureReasons = () =>
  events.emit.mock.calls
    .filter(([topic]) => topic === 'identity.user.registration.failed')
    .map(([, payload]) => (payload as { reason: string }).reason);

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
    const checkRegistration = vi.fn().mockResolvedValue({ allowed: false });
    const svc = makeService({ geoCheck: mock<GeoCheckCommands>({ checkRegistration }) });

    await expect(svc.register(validInput(), { 'x-real-ip': '203.0.113.7' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(checkRegistration).toHaveBeenCalledWith('203.0.113.7');
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
