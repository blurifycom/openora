import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ADMIN_GUARD,
  Container,
  ModuleRegistryImpl,
  DRIZZLE,
  EVENT_BUS,
  type CoreTokenCatalog,
} from '@openora/core/server';
import {
  ADMIN_USER_DIRECTORY,
  AUDIT_WRITER,
  IDENTITY_READER,
  PLAY_ELIGIBILITY,
  WITHDRAWAL_SECURITY,
  JOB_QUEUE,
  PLATFORM_CONFIG,
  RATE_LIMITER,
  definePlatformConfig,
  type PlatformConfig,
  KYC_WITHDRAWAL_POLICY,
  PLAYER_TAGS,
  type KycWithdrawalPolicy,
  type PlayerTags,
  REALTIME_TRANSPORT,
  type AdminUserDirectory,
  type PlayEligibilityPort,
  type RateLimiterAdapter,
} from '@openora/core/contracts';
import {
  makeAdminGuard,
  makeAuditWriter,
  makeEventBus,
  makeIdentityReader,
  makeWithdrawalSecurity,
  makeJobQueue,
  makeRealtimeTransport,
  mock,
} from '../../testing/mock.js';
import { walletBalanceChannel } from '../router/index.js';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import walletPlugin from '../plugin.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

function boot(platformConfig?: PlatformConfig) {
  const container = new Container<CoreTokenCatalog>();
  const events = makeEventBus();
  const realtime = makeRealtimeTransport();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => events);
  container.register(REALTIME_TRANSPORT, () => realtime);
  container.register(ADMIN_GUARD, () => makeAdminGuard());
  container.register(AUDIT_WRITER, () => makeAuditWriter());
  container.register(IDENTITY_READER, () => makeIdentityReader());
  container.register(PLAY_ELIGIBILITY, () => mock<PlayEligibilityPort>({}));
  container.register(WITHDRAWAL_SECURITY, () => makeWithdrawalSecurity());
  container.register(ADMIN_USER_DIRECTORY, () => mock<AdminUserDirectory>({}));
  container.register(RATE_LIMITER, () => mock<RateLimiterAdapter<string>>({}));
  container.register(PLAYER_TAGS, () => mock<PlayerTags>({}));
  container.register(KYC_WITHDRAWAL_POLICY, () => mock<KycWithdrawalPolicy>({}));
  const jobQueue = makeJobQueue();
  container.register(JOB_QUEUE, () => jobQueue);
  if (platformConfig) {
    container.register(PLATFORM_CONFIG, () => platformConfig);
  }

  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  walletPlugin.register(registry);
  // The router factory sets the closure's `realtimeTransport` ref that
  // `publishBalanceChanged` reads - matching real boot order, where router factories
  // run before any real event arrives.
  registry.routers.getAll().get('wallet')?.(container);

  return { registry, realtime, jobQueue };
}

describe('wallet plugin wallet.balance.changed wiring', () => {
  it('publishes a gameplay balance-change signal on the caller-scoped channel', async () => {
    const { registry, realtime } = boot();
    const handlers = registry.events.getAll().get('wallet.balance.changed') ?? [];
    expect(handlers).toHaveLength(1);

    const userId = randomUUID();
    const eventId = randomUUID();
    await handlers[0]?.handler(
      {
        userId,
        playerId: null,
        amount: '10',
        currency: 'USD',
        transactionId: randomUUID(),
        type: 'bet',
        direction: 'debit',
      },
      {
        eventId,
        topic: 'wallet.balance.changed',
        payload: {},
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
      },
    );

    expect(realtime.publish).toHaveBeenCalledWith(walletBalanceChannel(userId), {
      eventId,
      currency: 'USD',
      reason: 'gameplay',
    });
  });

  it('ignores a payload that fails schema validation, even with a valid envelope', async () => {
    const { registry, realtime } = boot();
    const handlers = registry.events.getAll().get('wallet.balance.changed') ?? [];

    await handlers[0]?.handler(
      { userId: 'not-a-uuid' },
      {
        eventId: randomUUID(),
        topic: 'wallet.balance.changed',
        payload: {},
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
      },
    );

    expect(realtime.publish).not.toHaveBeenCalled();
  });
});

describe('wallet plugin turnover pricing schedule', () => {
  const pricingSchedules = (jobQueue: ReturnType<typeof makeJobQueue>) =>
    vi
      .mocked(jobQueue.schedule)
      .mock.calls.filter(([, name]) => name === 'wallet-turnover-pricing.cron');

  it('schedules no pricing job while the multiplier is 0', () => {
    expect(pricingSchedules(boot().jobQueue)).toEqual([]);
    expect(
      pricingSchedules(
        boot(definePlatformConfig({ wallet: { turnover: { multiplier: '0' } } })).jobQueue,
      ),
    ).toEqual([]);
  });

  it('schedules the pricing job once the multiplier is on', () => {
    expect(
      pricingSchedules(
        boot(definePlatformConfig({ wallet: { turnover: { multiplier: '1' } } })).jobQueue,
      ),
    ).toHaveLength(1);
  });
});
