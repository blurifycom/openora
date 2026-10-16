import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  ADMIN_GUARD,
  Container,
  DRIZZLE,
  EVENT_BUS,
  ModuleRegistryImpl,
  findOneOrThrow,
  type CoreTokenCatalog,
} from '@openora/core/server';
import {
  AUDIT_WRITER,
  BONUS_GRANTS,
  JOB_QUEUE,
  PLAY_ELIGIBILITY,
  RATE_LIMITER,
  REALTIME_TRANSPORT,
  WALLET_READER,
  type PlayEligibilityPort,
  type WalletReader,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  makeAdminGuard,
  makeAuditWriter,
  makeEventBus,
  makeJobQueue,
  makeRateLimiter,
  makeRealtimeTransport,
  mock,
} from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { promoGrant, promoWeight, promoWeightProfile } from '../schema/index.js';
import bonusPlugin from '../plugin.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

function boot() {
  const container = new Container<CoreTokenCatalog>();
  const events = makeEventBus();
  const jobs = makeJobQueue();
  const audit = makeAuditWriter();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => events);
  container.register(JOB_QUEUE, () => jobs);
  container.register(AUDIT_WRITER, () => audit);
  container.register(WALLET_READER, () => mock<WalletReader>());
  container.register(PLAY_ELIGIBILITY, () => mock<PlayEligibilityPort>());
  container.register(REALTIME_TRANSPORT, () => makeRealtimeTransport());
  container.register(ADMIN_GUARD, () => makeAdminGuard());
  container.register(RATE_LIMITER, () => makeRateLimiter());
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  bonusPlugin.register(registry);
  registry.routers.getAll().get('promo-bonus')?.(container);

  const publish = (topic: string, payload: unknown, occurredAt = new Date().toISOString()) => {
    for (const handler of registry.events.getAll().get(topic) ?? []) {
      void handler(payload, {
        eventId: randomUUID(),
        topic,
        payload,
        occurredAt,
        schemaVersion: 2,
      });
    }
  };
  const runForfeitJob = async (payload: unknown) => {
    const worker = registry.jobs.getAll().find((w) => w.queue === 'promo-bonus-forfeit');
    if (!worker) {
      throw new Error('forfeit worker not registered');
    }
    await worker.handler({
      id: 'job-1',
      name: worker.queue,
      payload: worker.schema.parse(payload),
      attempt: 1,
      enqueuedAt: new Date(),
      meta: {},
    });
  };
  return { container, events, jobs, audit, publish, runForfeitJob };
}

async function grantFor(app: ReturnType<typeof boot>, userId: string) {
  const profileId = findOneOrThrow(
    await db.drizzle.db
      .insert(promoWeightProfile)
      .values({ name: `profile-${randomUUID()}` })
      .returning(),
    new Error('seed profile: query returned no row'),
  ).id;
  await db.drizzle.db.insert(promoWeight).values({
    profileId,
    scope: 'default',
    scopeRef: null,
    contributionPercent: '100',
  });
  const outcome = await db.drizzle.db.transaction((tx) =>
    app.container.get(BONUS_GRANTS).grant(tx, {
      userId,
      currency: 'USD',
      amount: '100',
      source: 'deposit',
      sourceRef: randomUUID(),
      actor: { type: 'system' },
      terms: { wageringMultiplier: '5', expiryDays: 30, weightProfileId: profileId },
    }),
  );
  if (!outcome.ok) {
    throw new Error('grant was refused');
  }
  return outcome.grantId;
}

const statusOf = async (grantId: string) =>
  findOneOrThrow(
    await db.drizzle.db
      .select({ status: promoGrant.status })
      .from(promoGrant)
      .where(eq(promoGrant.id, grantId)),
    new Error('grant row missing'),
  ).status;

const withdrawalRequested = (userId: string) => ({
  userId,
  playerId: null,
  amount: '100',
  currency: 'USD',
  transactionId: randomUUID(),
  ip: null,
  userAgent: null,
});

describe('a withdrawal requested while a bonus is active', () => {
  it('forfeits the bonus as the player with reason withdrawal_while_active', async () => {
    const app = boot();
    const userId = randomUUID();
    const grantId = await grantFor(app, userId);

    const requested = withdrawalRequested(userId);
    const occurredAt = new Date().toISOString();
    app.publish('wallet.withdrawal.requested', requested, occurredAt);

    expect(app.jobs.enqueue).toHaveBeenCalledWith(
      'promo-bonus-forfeit',
      {
        userId,
        reason: 'withdrawal_while_active',
        actorId: userId,
        actorIsAdmin: false,
        withdrawal: { transactionId: requested.transactionId, requestedAt: occurredAt },
      },
      expect.anything(),
    );

    await app.runForfeitJob(app.jobs.enqueue.mock.calls[0]?.[1]);

    expect(await statusOf(grantId)).toBe('forfeited');
    expect(app.audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'promo.bonus.forfeited',
        actorType: 'player',
        actorId: userId,
      }),
    );
    expect(app.events.emit).toHaveBeenCalledWith(
      'promo.bonus.forfeited',
      expect.objectContaining({ userId, grantId, reason: 'withdrawal_while_active' }),
    );
  });

  it('leaves a bonus held by another player active', async () => {
    const app = boot();
    const withdrawing = randomUUID();
    const bystanderGrant = await grantFor(app, randomUUID());
    await grantFor(app, withdrawing);

    app.publish('wallet.withdrawal.requested', withdrawalRequested(withdrawing));
    await app.runForfeitJob(app.jobs.enqueue.mock.calls[0]?.[1]);

    expect(await statusOf(bystanderGrant)).toBe('active');
  });

  it('leaves a bonus granted after the withdrawal was requested active', async () => {
    const app = boot();
    const userId = randomUUID();
    const heldGrant = await grantFor(app, userId);
    const occurredAt = new Date().toISOString();
    const laterGrant = await grantFor(app, userId);
    await db.drizzle.db
      .update(promoGrant)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(promoGrant.id, heldGrant));
    await db.drizzle.db
      .update(promoGrant)
      .set({ createdAt: new Date(Date.now() + 60_000) })
      .where(eq(promoGrant.id, laterGrant));

    app.publish('wallet.withdrawal.requested', withdrawalRequested(userId), occurredAt);
    await app.runForfeitJob(app.jobs.enqueue.mock.calls[0]?.[1]);

    expect(await statusOf(heldGrant)).toBe('forfeited');
    expect(await statusOf(laterGrant)).toBe('active');
  });

  it('enqueues nothing for a payload that fails validation', () => {
    const app = boot();

    app.publish('wallet.withdrawal.requested', { userId: 'not-a-uuid' });

    expect(app.jobs.enqueue).not.toHaveBeenCalledWith(
      'promo-bonus-forfeit',
      expect.anything(),
      expect.anything(),
    );
  });
});
