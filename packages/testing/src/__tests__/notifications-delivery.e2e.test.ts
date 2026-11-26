import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { JOB_QUEUE, queue } from '@openora/core/contracts';
import { notification } from '@openora/core/engagement/schema/notifications';
import {
  NotificationCountSchema,
  NotificationSchema,
} from '@openora/core/engagement/contracts/notifications';
import { bootE2e, closeE2e, newPlayer, type E2e } from '../index.js';

let e2e: E2e;

beforeAll(async () => {
  e2e = await bootE2e();
}, 60_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

type Member = Awaited<ReturnType<typeof newPlayer>>;

const PageSchema = z.object({ items: z.array(NotificationSchema), total: z.number() });
const ReadAllSchema = z.object({ count: z.number() });

const seed = async (userId: string, ageMinutes: number, readAt: Date | null = null) => {
  const [row] = await db()
    .insert(notification)
    .values({
      userId,
      type: 'vip.assigned',
      params: null,
      data: null,
      readAt,
      createdAt: new Date(Date.now() - ageMinutes * 60_000),
    })
    .returning();
  if (!row) {
    throw new Error('notification not seeded');
  }
  return row.id;
};

const listOf = async (who: Member) => {
  const res = await who.client.get('/notifications?page=1&limit=50');
  expect(res.status).toBe(200);
  return PageSchema.parse(await res.json());
};

const unreadOf = async (who: Member) => {
  const res = await who.client.get('/notifications/unread-count');
  expect(res.status).toBe(200);
  return NotificationCountSchema.parse(await res.json()).count;
};

describe('player notifications', () => {
  it('a player lists only their own notifications newest first', async () => {
    const owner = await newPlayer(e2e.app, 'nt-list');
    const other = await newPlayer(e2e.app, 'nt-list-other');
    const oldest = await seed(owner.userId, 30);
    const newest = await seed(owner.userId, 1);
    const middle = await seed(owner.userId, 10);
    const foreign = await seed(other.userId, 5);

    const page = await listOf(owner);

    expect(page.items.map((item) => item.id)).toEqual([newest, middle, oldest]);
    expect(page.items.every((item) => item.userId === owner.userId)).toBe(true);
    expect(page.items.map((item) => item.id)).not.toContain(foreign);
    expect(page.total).toBe(3);
  });

  it('unread count drops to zero after read-all and another player count is unchanged', async () => {
    const owner = await newPlayer(e2e.app, 'nt-readall');
    const other = await newPlayer(e2e.app, 'nt-readall-other');
    await seed(owner.userId, 3);
    await seed(owner.userId, 2);
    await seed(other.userId, 1);
    expect(await unreadOf(owner)).toBe(2);
    expect(await unreadOf(other)).toBe(1);

    const res = await owner.client.post('/notifications/read-all');

    expect(res.status).toBe(200);
    expect(ReadAllSchema.parse(await res.json()).count).toBe(2);
    expect(await unreadOf(owner)).toBe(0);
    expect(await unreadOf(other)).toBe(1);
  });

  it('read-all twice is idempotent', async () => {
    const owner = await newPlayer(e2e.app, 'nt-twice');
    await seed(owner.userId, 2);
    await seed(owner.userId, 1);

    const first = await owner.client.post('/notifications/read-all');
    const readAtAfterFirst = (await listOf(owner)).items.map((item) => item.readAt);
    const second = await owner.client.post('/notifications/read-all');

    expect(first.status).toBe(200);
    expect(ReadAllSchema.parse(await first.json()).count).toBe(2);
    expect(second.status).toBe(200);
    expect(ReadAllSchema.parse(await second.json()).count).toBe(0);
    expect((await listOf(owner)).items.map((item) => item.readAt)).toEqual(readAtAfterFirst);
    expect(await unreadOf(owner)).toBe(0);
  });

  it('an unauthenticated caller cannot list, count or read all notifications', async () => {
    const owner = await newPlayer(e2e.app, 'nt-anon');
    await seed(owner.userId, 1);

    const list = await e2e.app.app.request('/notifications?page=1&limit=50');
    const count = await e2e.app.app.request('/notifications/unread-count');
    const readAll = await e2e.app.app.request('/notifications/read-all', { method: 'POST' });

    expect([list.status, count.status, readAll.status]).toEqual([401, 401, 401]);
    expect(await unreadOf(owner)).toBe(1);
  });

  it.todo(
    'GAP: a notification disabled by the player preferences is not created (no per-player notification preference exists; only the opt-in security alert mail is preference-gated)',
  );

  it('a notification queued twice with the same key is delivered once', async () => {
    const owner = await newPlayer(e2e.app, 'nt-dedupe');
    const eventId = randomUUID();
    const job = {
      event: 'vip.assigned',
      input: {
        userId: owner.userId,
        type: 'vip.assigned',
        params: null,
        data: null,
        title: '',
        body: '',
        eventId,
      },
      email: null,
      securityAlert: false,
    };
    const jobs = e2e.app.container.get(JOB_QUEUE);

    await jobs.enqueue(queue('notifications-dispatch'), job, {
      idempotencyKey: `nt-dedupe-a:${eventId}`,
    });
    await jobs.enqueue(queue('notifications-dispatch'), job, {
      idempotencyKey: `nt-dedupe-b:${eventId}`,
    });

    const sentinelEventId = randomUUID();
    await jobs.enqueue(
      queue('notifications-dispatch'),
      { ...job, input: { ...job.input, eventId: sentinelEventId } },
      { idempotencyKey: `nt-dedupe-sentinel:${sentinelEventId}` },
    );

    await vi.waitFor(async () => expect((await listOf(owner)).total).toBeGreaterThanOrEqual(2), {
      timeout: 15_000,
    });
    const rows = await db().select().from(notification).where(eq(notification.eventId, eventId));
    expect(rows).toHaveLength(1);
    expect((await listOf(owner)).total).toBe(2);
  });

  it('a notification arrives on the player stream and not on another player stream', async () => {
    const target = await newPlayer(e2e.app, 'nt-stream-t');
    const bystander = await newPlayer(e2e.app, 'nt-stream-b');
    const sender = await newPlayer(e2e.app, 'nt-stream-s');
    const watch = async (who: Member) => {
      const abort = new AbortController();
      const res = await who.client.request('/notifications/stream', {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        signal: abort.signal,
      });
      expect(res.status).toBe(200);
      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error('notification stream has no body');
      }
      const decoder = new TextDecoder();
      const state = { received: '' };
      const pump = (async () => {
        for (;;) {
          const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
          if (chunk.done) {
            return;
          }
          state.received += decoder.decode(chunk.value);
        }
      })();
      const close = async () => {
        abort.abort();
        await reader.cancel().catch(() => undefined);
        await pump;
      };
      return { state, close };
    };
    const targetStream = await watch(target);
    const bystanderStream = await watch(bystander);

    try {
      const sent = await sender.client.post('/social/friend-requests', {
        targetUserId: target.userId,
      });
      expect(sent.status).toBe(200);
      await vi.waitFor(
        () => expect(targetStream.state.received).toContain('social.friend_request.received'),
        { timeout: 15_000 },
      );
      const sentinelSender = await newPlayer(e2e.app, 'nt-stream-x');
      const sentinel = await sentinelSender.client.post('/social/friend-requests', {
        targetUserId: bystander.userId,
      });
      expect(sentinel.status).toBe(200);

      await vi.waitFor(
        () => expect(bystanderStream.state.received).toContain(sentinelSender.userId),
        { timeout: 15_000 },
      );
      expect(bystanderStream.state.received).not.toContain(sender.userId);
    } finally {
      await targetStream.close();
      await bystanderStream.close();
    }
  });
});
