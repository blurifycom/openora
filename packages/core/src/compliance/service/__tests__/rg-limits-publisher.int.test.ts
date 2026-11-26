import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql, type SQL } from 'drizzle-orm';
import { RgLimitsSnapshotSchema, type RgLimitsSnapshot, type Uuid } from '@openora/core/contracts';
import { createTestDb, waitForRowLockWaiter, type TestDb } from '../../../testing/real-infra.js';
import { migrate } from '../../migrate.js';
import { rgLimitVersion, userLimit } from '../../schema/index.js';
import { RgLimitsPublisher, backfillRgLimits } from '../rg-limits-publisher.service.js';

type Executor = { execute(query: SQL): Promise<{ rows: unknown[] }> };

function isExecutor(tx: unknown): tx is Executor {
  return (
    typeof tx === 'object' && tx !== null && 'execute' in tx && typeof tx.execute === 'function'
  );
}

function executorOf(tx: unknown): Executor {
  if (isExecutor(tx)) {
    return tx;
  }
  throw new Error('not a transaction');
}

const SnapshotRowSchema = RgLimitsSnapshotSchema.pick({ version: true, limits: true });

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb([migrate]);
  await testDb.drizzle.db.execute(sql`
    create table rg_ledger_double (user_id uuid primary key, snapshot jsonb not null)
  `);
  await testDb.drizzle.db.execute(sql`
    create table rg_event_double (
      id serial primary key, user_id uuid not null, payload jsonb not null
    )
  `);
}, 120_000);

afterAll(() => testDb.drop());

const db = () => testDb.drizzle.db;

class LedgerDouble {
  constructor(
    private readonly scope: ReadonlySet<string>,
    private readonly onWrite: () => void = () => undefined,
  ) {}

  async write(snapshot: RgLimitsSnapshot, tx: unknown): Promise<void> {
    await executorOf(tx).execute(sql`
      insert into rg_ledger_double (user_id, snapshot)
      values (${snapshot.userId}, ${JSON.stringify(snapshot)}::jsonb)
      on conflict (user_id) do update set snapshot = excluded.snapshot
    `);
    this.onWrite();
  }

  async drifted(snapshots: readonly RgLimitsSnapshot[]): Promise<string[]> {
    const drifted: string[] = [];
    for (const snapshot of snapshots) {
      if (!this.scope.has(snapshot.userId)) {
        continue;
      }
      const stored = await storedSnapshot(snapshot.userId);
      if (!stored || !isDeepStrictEqual(stored, snapshot)) {
        drifted.push(snapshot.userId);
      }
    }
    return drifted;
  }
}

class EventsDouble {
  constructor(private readonly failFor: ReadonlySet<string> = new Set()) {}

  async emitInTransaction(tx: unknown, _topic: string, raw: unknown): Promise<void> {
    const payload = RgLimitsSnapshotSchema.parse(raw);
    if (this.failFor.has(payload.userId)) {
      throw new Error('outbox unavailable');
    }
    await executorOf(tx).execute(sql`
      insert into rg_event_double (user_id, payload)
      values (${payload.userId}, ${JSON.stringify(payload)}::jsonb)
    `);
  }
}

async function storedSnapshot(userId: Uuid): Promise<RgLimitsSnapshot | null> {
  const { rows } = await db().execute<{ snapshot: unknown }>(
    sql`select snapshot from rg_ledger_double where user_id = ${userId}`,
  );
  const row = rows[0];
  return row ? RgLimitsSnapshotSchema.parse(row.snapshot) : null;
}

async function storedEvents(userId: Uuid): Promise<RgLimitsSnapshot[]> {
  const { rows } = await db().execute<{ payload: unknown }>(
    sql`select payload from rg_event_double where user_id = ${userId} order by id`,
  );
  return rows.map((row) => RgLimitsSnapshotSchema.parse(row.payload));
}

async function versionOf(userId: Uuid): Promise<number | null> {
  const [row] = await db().select().from(rgLimitVersion).where(eq(rgLimitVersion.userId, userId));
  return row?.version ?? null;
}

type LimitSeed = Partial<typeof userLimit.$inferInsert>;

async function seedLimit(userId: Uuid, overrides: LimitSeed = {}) {
  const [row] = await db()
    .insert(userLimit)
    .values({
      userId,
      type: 'deposit',
      period: 'daily',
      amount: '100.000000000000000000',
      currency: 'USD',
      updatedAt: new Date(),
      ...overrides,
    })
    .returning();
  if (!row) {
    throw new Error('limit seed failed');
  }
  return row;
}

function publisherFor(users: Uuid[], events: EventsDouble | null = new EventsDouble()) {
  const ledger = new LedgerDouble(new Set(users));
  return { ledger, publisher: new RgLimitsPublisher(ledger, events) };
}

const publish = (publisher: RgLimitsPublisher, userId: Uuid) =>
  db().transaction((tx) => publisher.publish(tx, userId));

describe('limit projection snapshot', () => {
  it('publishing for a new user writes version 1 and a snapshot of every limit', async () => {
    const userId = randomUUID();
    const deposit = await seedLimit(userId);
    const wager = await seedLimit(userId, {
      type: 'wager',
      period: 'weekly',
      amount: '25.500000000000000000',
      currency: 'EUR',
    });
    await seedLimit(userId, {
      type: 'session',
      period: 'session',
      amount: null,
      currency: null,
      minutes: 30,
    });
    const { publisher } = publisherFor([userId]);

    await publish(publisher, userId);

    expect(await versionOf(userId)).toBe(1);
    const stored = SnapshotRowSchema.parse(await storedSnapshot(userId));
    expect(stored.version).toBe(1);
    expect(stored.limits).toHaveLength(2);
    expect(stored.limits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          limitId: deposit.id,
          type: 'deposit',
          period: 'daily',
          amount: '100.000000000000000000',
          currency: 'USD',
        }),
        expect.objectContaining({
          limitId: wager.id,
          type: 'wager',
          period: 'weekly',
          amount: '25.500000000000000000',
          currency: 'EUR',
        }),
      ]),
    );
  });

  it('publishing again bumps the version by one', async () => {
    const userId = randomUUID();
    await seedLimit(userId);
    const { publisher } = publisherFor([userId]);

    await publish(publisher, userId);
    await publish(publisher, userId);

    expect(await versionOf(userId)).toBe(2);
    expect((await storedSnapshot(userId))?.version).toBe(2);
    expect((await storedEvents(userId)).map((event) => event.version)).toEqual([1, 2]);
  });

  it('a row that fails the snapshot contract is projected as a zero-amount limit that refuses every move', async () => {
    const userId = randomUUID();
    const broken = await seedLimit(userId, { currency: '' });
    const { publisher } = publisherFor([userId]);

    await publish(publisher, userId);

    const stored = SnapshotRowSchema.parse(await storedSnapshot(userId));
    expect(stored.limits).toEqual([
      expect.objectContaining({ limitId: broken.id, amount: '0', currency: null }),
    ]);
  });

  it('the snapshot is written to the limit ledger in the caller transaction and rolls back with it', async () => {
    const userId = randomUUID();
    await seedLimit(userId);
    const { publisher } = publisherFor([userId]);

    await expect(
      db().transaction(async (tx) => {
        await publisher.publish(tx, userId);
        throw new Error('caller failed after publishing');
      }),
    ).rejects.toThrow('caller failed after publishing');

    expect(await storedSnapshot(userId)).toBeNull();
    expect(await versionOf(userId)).toBeNull();
  });

  it('the changed event is emitted in the same transaction as the snapshot', async () => {
    const committed = randomUUID();
    const refused = randomUUID();
    await seedLimit(committed);
    await seedLimit(refused);
    const { publisher } = publisherFor([committed]);
    const failingEvents = publisherFor([refused], new EventsDouble(new Set([refused])));

    await publish(publisher, committed);
    await expect(publish(failingEvents.publisher, refused)).rejects.toThrow('outbox unavailable');

    const stored = await storedSnapshot(committed);
    expect(await storedEvents(committed)).toEqual([stored]);
    expect(await storedSnapshot(refused)).toBeNull();
    expect(await storedEvents(refused)).toEqual([]);
    expect(await versionOf(refused)).toBeNull();
  });

  it('concurrent publishes for one user serialize and read the limits after the previous commit', async () => {
    const userId = randomUUID();
    const base = await seedLimit(userId);
    const { publisher } = publisherFor([userId]);
    await publish(publisher, userId);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstPublished: () => void = () => undefined;
    const published = new Promise<void>((resolve) => {
      firstPublished = resolve;
    });
    let firstLimitId = '';
    const first = db().transaction(async (tx) => {
      const [row] = await tx
        .insert(userLimit)
        .values({
          userId,
          type: 'wager',
          period: 'daily',
          amount: '5.000000000000000000',
          currency: 'USD',
          updatedAt: new Date(),
        })
        .returning();
      firstLimitId = row?.id ?? '';
      await publisher.publish(tx, userId);
      firstPublished();
      await gate;
    });
    await published;

    let secondLimitId = '';
    const second = db().transaction(async (tx) => {
      const [row] = await tx
        .insert(userLimit)
        .values({
          userId,
          type: 'deposit',
          period: 'weekly',
          amount: '70.000000000000000000',
          currency: 'USD',
          updatedAt: new Date(),
        })
        .returning();
      secondLimitId = row?.id ?? '';
      await publisher.publish(tx, userId);
    });
    await waitForRowLockWaiter(testDb);
    expect(await versionOf(userId)).toBe(1);
    release();
    await Promise.all([first, second]);

    expect(await versionOf(userId)).toBe(3);
    const stored = SnapshotRowSchema.parse(await storedSnapshot(userId));
    expect(stored.version).toBe(3);
    expect(stored.limits.map((limit) => limit.limitId).sort()).toEqual(
      [base.id, firstLimitId, secondLimitId].sort(),
    );
    expect((await storedEvents(userId)).map((event) => event.version)).toEqual([1, 2, 3]);
  });

  it('backfill repairs users whose snapshot is missing or stale and skips current ones', async () => {
    const missing = randomUUID();
    const stale = randomUUID();
    const current = randomUUID();
    await seedLimit(missing);
    const staleLimit = await seedLimit(stale);
    await seedLimit(current);
    const scoped = publisherFor([missing, stale, current]);
    await publish(scoped.publisher, stale);
    await publish(scoped.publisher, current);
    const currentBefore = await storedSnapshot(current);
    await db()
      .update(userLimit)
      .set({ amount: '250.000000000000000000', updatedAt: new Date() })
      .where(eq(userLimit.id, staleLimit.id));

    const repaired = await backfillRgLimits(db(), scoped.ledger);

    expect(repaired).toBe(2);
    expect((await storedSnapshot(missing))?.version).toBe(1);
    const repairedStale = SnapshotRowSchema.parse(await storedSnapshot(stale));
    expect(repairedStale.version).toBe(2);
    expect(repairedStale.limits).toEqual([
      expect.objectContaining({ amount: '250.000000000000000000' }),
    ]);
    expect(await storedSnapshot(current)).toEqual(currentBefore);
    expect(await versionOf(current)).toBe(1);
  });

  it('backfill with a changed-since date only visits users with a limit updated since then', async () => {
    const recent = randomUUID();
    const old = randomUUID();
    await seedLimit(recent, { updatedAt: new Date() });
    await seedLimit(old, { updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) });
    const scoped = publisherFor([recent, old]);

    const repaired = await backfillRgLimits(db(), scoped.ledger, {
      changedSince: new Date(Date.now() - 60 * 60 * 1000),
    });

    expect(repaired).toBe(1);
    expect((await storedSnapshot(recent))?.version).toBe(1);
    expect(await storedSnapshot(old)).toBeNull();
  });

  it('backfill stops when its abort signal fires', async () => {
    const users = [randomUUID(), randomUUID(), randomUUID()];
    for (const userId of users) {
      await seedLimit(userId);
    }
    const controller = new AbortController();
    const ledger = new LedgerDouble(new Set(users), () => controller.abort());

    await expect(
      backfillRgLimits(db(), ledger, { batchSize: 1, signal: controller.signal }),
    ).rejects.toThrow();

    const written: (RgLimitsSnapshot | null)[] = [];
    for (const userId of users) {
      written.push(await storedSnapshot(userId));
    }
    expect(written.filter((snapshot) => snapshot !== null)).toHaveLength(1);
  });
});
