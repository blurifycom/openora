import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { DRIZZLE, EVENT_BUS } from '@openora/core/server';
import type { EventHandler, PluginContext, CoreTokenCatalog } from '@openora/core/server';
import {
  ADMIN_USER_DIRECTORY,
  JOB_QUEUE,
  NOTIFICATION_DELIVERY_ADAPTER,
  PLATFORM_CONFIG,
  REALTIME_TRANSPORT,
  type AdminUserDirectory,
  type EnqueueOptions,
  type JobQueueAdapter,
  type NotificationDeliveryAdapter,
  type QueueName,
  type WorkerRegistration,
} from '@openora/core/contracts';
import { makeEventBus, makeRealtimeTransport, mock } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { notification } from '../schema/index.js';
import notificationsPlugin from '../plugin.js';

let db: TestDb;

/**
 * Runs the notifications plugin's real `register()` against a minimal context, then its
 * router factory (which is what wires the service the workers publish through). The job
 * queue double runs handlers inline and honours `idempotencyKey`, so a test sees the whole
 * subscribe -> enqueue -> dispatch path the same way a real deployment does, without a
 * broker. Cheaper than the full e2e boot, and it exercises the actual wiring rather than a
 * copy of its body.
 */
function bootPlugin() {
  const handlers = new Map<string, EventHandler[]>();
  const workers = new Map<string, WorkerRegistration<unknown>>();
  const enqueued: { queue: string; key: string | undefined }[] = [];
  const seenKeys = new Set<string>();
  let routerFactory: ((c: unknown) => unknown) | null = null;

  // A subscription enqueues without awaiting - it is fire-and-forget by design - so the
  // in-flight jobs are tracked here and drained before a test reads the table.
  const pending: Promise<unknown>[] = [];
  const jobQueue = mock<JobQueueAdapter>({
    enqueue: (name: QueueName, payload: unknown, opts?: EnqueueOptions) => {
      enqueued.push({ queue: name, key: opts?.idempotencyKey });
      // At-most-one active job per key, the way a durable driver dedupes on job id.
      const duplicate = Boolean(opts?.idempotencyKey && seenKeys.has(opts.idempotencyKey));
      if (opts?.idempotencyKey) {
        seenKeys.add(opts.idempotencyKey);
      }
      const run = (async () => {
        const worker = workers.get(name);
        if (!duplicate && worker) {
          await worker.handler({
            id: randomUUID(),
            name,
            payload: worker.schema.parse(payload),
            attempt: 1,
            enqueuedAt: new Date(),
            meta: {},
          });
        }
        return { id: randomUUID() };
      })();
      pending.push(run);
      return run;
    },
    schedule: async () => undefined,
  });

  const ctx = mock<PluginContext<CoreTokenCatalog>>({
    provide: () => undefined,
    events: {
      on: (event: string, handler: EventHandler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    },
    jobs: {
      worker: (registration: WorkerRegistration<unknown>) => {
        workers.set(registration.queue, registration);
      },
    },
    routers: {
      add: (_namespace: string, factory: (c: unknown) => unknown) => {
        routerFactory = factory;
      },
    },
  });
  notificationsPlugin.register(ctx);

  const delivery = mock<NotificationDeliveryAdapter>({ sendEmail: async () => undefined });
  const directory = mock<AdminUserDirectory>({ get: async () => null });
  // Only ever resolved out of the container - this test asserts on notification rows and
  // enqueued jobs, never on a realtime publish, so the mock stands in for the transport.
  const realtime = makeRealtimeTransport();
  const container = {
    get: (token: unknown) =>
      token === DRIZZLE
        ? db.drizzle
        : token === EVENT_BUS
          ? makeEventBus()
          : token === NOTIFICATION_DELIVERY_ADAPTER
            ? delivery
            : token === ADMIN_USER_DIRECTORY
              ? directory
              : token === JOB_QUEUE
                ? jobQueue
                : token === REALTIME_TRANSPORT
                  ? realtime
                  : undefined,
    has: (token: unknown) => token !== PLATFORM_CONFIG,
    onDispose: () => undefined,
  };
  routerFactory!(container);

  const fire = async (event: string, payload: unknown, eventId = randomUUID()) => {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload, { eventId } as never);
    }
    while (pending.length > 0) {
      await Promise.all(pending.splice(0));
    }
    return eventId;
  };
  return { fire, enqueued };
}

function readNotifications() {
  return db.drizzle.db.select().from(notification).orderBy(asc(notification.createdAt));
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${notification} RESTART IDENTITY CASCADE`);
});

describe('notifications plugin - chat room ownership (real PG)', () => {
  it('notifies the inheriting owner, and nobody else', async () => {
    const { fire } = bootPlugin();
    const roomId = randomUUID();
    const newOwnerId = randomUUID();

    await fire('chat.room.ownership.transferred', {
      roomId,
      roomName: 'Wheel Spin',
      previousOwnerId: randomUUID(),
      newOwnerId,
      reason: 'account-closed',
    });

    const rows = await readNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: newOwnerId,
      type: 'chat.room.ownership_transferred',
      title: 'You are now the owner of a chat room',
      data: { roomId },
    });
    expect(rows[0]!.body).toContain('Wheel Spin');
  });

  it('notifies every member of a room on the countdown except the closed owner', async () => {
    const { fire } = bootPlugin();
    const roomId = randomUUID();
    const previousOwnerId = randomUUID();
    const memberIds = [randomUUID(), randomUUID()];

    await fire('chat.room.scheduled_for_deletion', {
      roomId,
      roomName: 'Wheel Spin',
      previousOwnerId,
      // The closed owner is on the roster snapshot - their row is kept and marked, not
      // removed - so the handler is what has to leave them out.
      memberIds: [previousOwnerId, ...memberIds],
      scheduledDeletionAt: new Date('2026-09-30T10:00:00.000Z').toISOString(),
    });

    const rows = await readNotifications();
    expect(rows.map((r) => r.userId).sort()).toEqual([...memberIds].sort());
    expect(rows[0]).toMatchObject({
      type: 'chat.room.scheduled_for_deletion',
      title: 'Chat room closing',
      data: { roomId },
    });
    expect(rows[0]!.body).toContain('30 days');
  });

  it('produces exactly one notification for a room whose only other member is closed', async () => {
    const { fire } = bootPlugin();
    const previousOwnerId = randomUUID();
    const activeId = randomUUID();

    // The shape the emitter now produces for a room holding one active member and one
    // already-closed member: the closed member never reaches the audience at all.
    await fire('chat.room.scheduled_for_deletion', {
      roomId: randomUUID(),
      roomName: 'Wheel Spin',
      previousOwnerId,
      memberIds: [activeId],
      scheduledDeletionAt: new Date('2026-09-30T10:00:00.000Z').toISOString(),
    });

    const rows = await readNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: activeId, type: 'chat.room.scheduled_for_deletion' });
  });

  it('keys the fan-out per member, so a redelivered event notifies nobody twice', async () => {
    const { fire, enqueued } = bootPlugin();
    const previousOwnerId = randomUUID();
    const memberIds = [randomUUID(), randomUUID()];
    const payload = {
      roomId: randomUUID(),
      roomName: 'Wheel Spin',
      previousOwnerId,
      memberIds: [previousOwnerId, ...memberIds],
      scheduledDeletionAt: new Date('2026-09-30T10:00:00.000Z').toISOString(),
    };

    const eventId = await fire('chat.room.scheduled_for_deletion', payload);
    // One dispatch key per recipient: a single key for the whole event would collide and
    // silently drop every member after the first.
    expect(new Set(enqueued.map((e) => e.key)).size).toBe(memberIds.length);
    for (const userId of memberIds) {
      expect(enqueued.map((e) => e.key)).toContain(`notifications-dispatch:${eventId}:${userId}`);
    }

    // At-least-once delivery: the same event redelivered must not double-notify, because
    // every recipient's key is already taken.
    await fire('chat.room.scheduled_for_deletion', payload, eventId);

    const rows = await readNotifications();
    expect(rows).toHaveLength(memberIds.length);
  });
});
