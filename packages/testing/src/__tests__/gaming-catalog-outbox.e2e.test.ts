import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, eventOutbox, processedEvents } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { game, gameProvider } from '@openora/core/casino/schema/gaming';
import { asAdmin, bootE2e, closeE2e, flushAudit, type E2e, type TestClient } from '../index.js';

type CatalogE2e = E2e & { admin: TestClient };

let e2e: CatalogE2e;

beforeAll(async () => {
  const booted = await bootE2e();
  try {
    e2e = { ...booted, admin: await asAdmin(booted.app.app) };
  } catch (err) {
    await closeE2e(booted);
    throw err;
  }
}, 120_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

async function idOf(res: Response): Promise<string> {
  if (res.status !== 200) {
    throw new Error(`request failed (${res.status}): ${await res.text()}`);
  }
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null || !('id' in body) || typeof body.id !== 'string') {
    throw new Error('response carries no id');
  }
  return body.id;
}

const outboxRows = (topic: string, key: string, id: string) =>
  db()
    .select()
    .from(eventOutbox)
    .where(and(eq(eventOutbox.topic, topic), sql`${eventOutbox.payload}->>${key} = ${id}`));

async function expectOutboxed(topic: string, key: string, id: string) {
  const rows = await outboxRows(topic, key, id);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const auditRowsOf = async (eventId: string) => {
  await flushAudit(e2e.app);
  return db().select().from(auditLog).where(eq(auditLog.eventId, eventId));
};

async function newGame() {
  const [provider] = await db()
    .insert(gameProvider)
    .values({ slug: `outbox-prov-${randomUUID()}`, name: 'Outbox Provider' })
    .returning();
  const [created] = await db()
    .insert(game)
    .values({
      name: 'Outbox Game',
      slug: `outbox-game-${randomUUID()}`,
      providerId: provider!.id,
      aggregator: 'outbox-e2e',
      isActive: true,
      reviewStatus: 'approved',
    })
    .returning();
  return { gameId: created!.id, providerId: provider!.id };
}

describe('catalogue mutations reach the outbox with the transaction that made them', () => {
  it('writes an outbox row and an audit record for a tag created, renamed and deleted', async () => {
    const name = `outbox-tag-${randomUUID()}`;
    const tagId = await idOf(await e2e.admin.post('/backoffice/gaming/tags', { name }));
    const created = await expectOutboxed('gaming.tag.created', 'tagId', tagId);
    expect(await auditRowsOf(created.eventId)).toHaveLength(1);

    expect(
      (await e2e.admin.patch(`/backoffice/gaming/tags/${tagId}`, { name: `${name}-b` })).status,
    ).toBe(200);
    const updated = await expectOutboxed('gaming.tag.updated', 'tagId', tagId);
    expect(await auditRowsOf(updated.eventId)).toHaveLength(1);

    expect((await e2e.admin.del(`/backoffice/gaming/tags/${tagId}`)).status).toBe(200);
    const deleted = await expectOutboxed('gaming.tag.deleted', 'tagId', tagId);
    expect(await auditRowsOf(deleted.eventId)).toHaveLength(1);
  });

  it('writes an outbox row for a provider and a category created and updated', async () => {
    const providerId = await idOf(
      await e2e.admin.post('/backoffice/gaming/providers', {
        slug: `outbox-prov-${randomUUID()}`,
        name: 'Outbox Provider',
      }),
    );
    await expectOutboxed('gaming.provider.created', 'providerId', providerId);
    expect(
      (await e2e.admin.patch(`/backoffice/gaming/providers/${providerId}`, { isActive: false }))
        .status,
    ).toBe(200);
    await expectOutboxed('gaming.provider.updated', 'providerId', providerId);

    const categoryId = await idOf(
      await e2e.admin.post('/backoffice/gaming/categories', {
        name: 'Outbox Category',
        slug: `outbox-cat-${randomUUID()}`,
      }),
    );
    await expectOutboxed('gaming.category.created', 'categoryId', categoryId);
    expect(
      (await e2e.admin.patch(`/backoffice/gaming/categories/${categoryId}`, { name: 'Renamed' }))
        .status,
    ).toBe(200);
    await expectOutboxed('gaming.category.updated', 'categoryId', categoryId);
  });

  it('writes an outbox row for a game edited and a bulk switch', async () => {
    const { gameId } = await newGame();
    expect(
      (await e2e.admin.patch(`/backoffice/gaming/games/${gameId}`, { isActive: false })).status,
    ).toBe(200);
    await expectOutboxed('gaming.game.updated', 'gameId', gameId);

    const bulk = await e2e.admin.post('/backoffice/gaming/games/bulk/active', {
      gameIds: [gameId],
      isActive: true,
    });
    expect(bulk.status).toBe(200);
    const rows = await db()
      .select()
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.topic, 'gaming.games.bulk_updated'),
          sql`${eventOutbox.payload}->'changedGameIds' ? ${gameId}`,
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it('leaves no outbox row behind a refused mutation', async () => {
    const name = `outbox-dup-${randomUUID()}`;
    await idOf(await e2e.admin.post('/backoffice/gaming/tags', { name }));
    const before = await db()
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.topic, 'gaming.tag.created'));

    const refused = await e2e.admin.post('/backoffice/gaming/tags', { name });

    expect(refused.status).toBeGreaterThanOrEqual(400);
    const after = await db()
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.topic, 'gaming.tag.created'));
    expect(after).toHaveLength(before.length);
  });

  it('applies a redelivered event once', async () => {
    const tagId = await idOf(
      await e2e.admin.post('/backoffice/gaming/tags', { name: `outbox-replay-${randomUUID()}` }),
    );
    const { eventId } = await expectOutboxed('gaming.tag.created', 'tagId', tagId);
    await vi.waitFor(async () => {
      const [row] = await db().select().from(eventOutbox).where(eq(eventOutbox.eventId, eventId));
      expect(row?.publishedAt).not.toBeNull();
    });
    await vi.waitFor(async () => {
      const handled = await db()
        .select()
        .from(processedEvents)
        .where(eq(processedEvents.eventId, eventId));
      expect(handled.length).toBeGreaterThan(0);
    });
    const handledBefore = await db()
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.eventId, eventId));

    await db()
      .update(eventOutbox)
      .set({ publishedAt: null, claimedAt: null })
      .where(eq(eventOutbox.eventId, eventId));
    await vi.waitFor(async () => {
      const [row] = await db().select().from(eventOutbox).where(eq(eventOutbox.eventId, eventId));
      expect(row?.publishedAt).not.toBeNull();
    });

    expect(await auditRowsOf(eventId)).toHaveLength(1);
    const handledAfter = await db()
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.eventId, eventId));
    expect(handledAfter).toHaveLength(handledBefore.length);
  });
});
