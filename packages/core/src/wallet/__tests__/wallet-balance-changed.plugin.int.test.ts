import { describe, it, expect } from 'vitest';
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
  JOB_QUEUE,
  RATE_LIMITER,
  REALTIME_TRANSPORT,
  type AdminUserDirectory,
  type RateLimiterAdapter,
} from '@openora/core/contracts';
import {
  makeAdminGuard,
  makeAuditWriter,
  makeDrizzle,
  makeEventBus,
  makeIdentityReader,
  makeJobQueue,
  makeRealtimeTransport,
  mock,
} from '../../testing/mock.js';
import { walletBalanceChannel } from '../router/index.js';
import walletPlugin from '../plugin.js';

function boot() {
  const container = new Container<CoreTokenCatalog>();
  const events = makeEventBus();
  const realtime = makeRealtimeTransport();
  container.register(DRIZZLE, () => makeDrizzle());
  container.register(EVENT_BUS, () => events);
  container.register(REALTIME_TRANSPORT, () => realtime);
  container.register(ADMIN_GUARD, () => makeAdminGuard());
  container.register(AUDIT_WRITER, () => makeAuditWriter());
  container.register(IDENTITY_READER, () => makeIdentityReader());
  container.register(ADMIN_USER_DIRECTORY, () => mock<AdminUserDirectory>({}));
  container.register(RATE_LIMITER, () => mock<RateLimiterAdapter<string>>({}));
  container.register(JOB_QUEUE, () => makeJobQueue());

  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  walletPlugin.register(registry);
  // The router factory sets the closure's `realtimeTransport` ref that
  // `publishBalanceChanged` reads - matching real boot order, where router factories
  // run before any real event arrives.
  registry.routers.getAll().get('wallet')?.(container);

  return { registry, realtime };
}

describe('wallet plugin wallet.balance.changed wiring', () => {
  it('publishes a gameplay balance-change signal on the caller-scoped channel', async () => {
    const { registry, realtime } = boot();
    const handlers = registry.events.getAll().get('wallet.balance.changed') ?? [];
    expect(handlers).toHaveLength(1);

    const userId = randomUUID();
    const eventId = randomUUID();
    await handlers[0]?.(
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

    await handlers[0]?.(
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
