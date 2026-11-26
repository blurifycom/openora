import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type {
  PlayEligibilityProjectionPort,
  PlayEligibilitySnapshot,
} from '@openora/core/contracts';
import type { EventBus } from '@openora/core/server';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { createTestDb, seedPlayerWithUser, type TestDb } from '../../../testing/index.js';
import { migrate } from '../migrate.js';
import { user } from '../schema/index.js';
import { PlayEligibilityPublisher } from '../service/play-eligibility.service.js';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb([migrate, migrateProfile]);
}, 120_000);

afterAll(() => testDb.drop());

const db = () => testDb.drizzle.db;

function recordingProjection(remote: boolean, fail = false) {
  const written: PlayEligibilitySnapshot[] = [];
  const projection: PlayEligibilityProjectionPort = {
    remote,
    reconcile: async () => 0,
    heartbeat: async () => {},
    write: async (snapshot) => {
      if (fail) {
        throw new Error('ledger unreachable');
      }
      written.push(snapshot);
    },
  };
  return { projection, written };
}

function recordingEvents() {
  const emitted: unknown[] = [];
  const events: EventBus = {
    emit() {},
    emitRaw() {},
    emitInTransaction: async (_tx, _topic, payload) => {
      emitted.push(payload);
    },
    on: () => () => {},
    tapTransactional() {},
  };
  return { events, emitted };
}

function publisherOver(projection: PlayEligibilityProjectionPort) {
  const { events, emitted } = recordingEvents();
  const publisher = new PlayEligibilityPublisher(testDb.drizzle, events, () => projection);
  return { publisher, emitted };
}

async function seededUser() {
  const { account } = await seedPlayerWithUser(testDb);
  return account.id;
}

const setBlocked = (userId: string, rgBlocked: boolean) =>
  db().update(user).set({ rgBlocked }).where(eq(user.id, userId));

const versionOf = async (userId: string) => {
  const [row] = await db()
    .select({ version: user.playEligibilityVersion })
    .from(user)
    .where(eq(user.id, userId));
  return row?.version;
};

describe('a play eligibility projection written from another service (ADR-0062)', () => {
  it('writes a block to a remote ledger in the caller transaction and emits the event', async () => {
    const userId = await seededUser();
    const { projection, written } = recordingProjection(true);
    const { publisher, emitted } = publisherOver(projection);
    await setBlocked(userId, true);

    await db().transaction((tx) => publisher.publish(tx, userId));

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ userId, rgBlocked: true, version: 1 });
    expect(emitted).toHaveLength(1);
  });

  it('fails a block when the remote ledger write throws, and commits nothing', async () => {
    const userId = await seededUser();
    const { projection } = recordingProjection(true, true);
    const { publisher, emitted } = publisherOver(projection);

    await expect(
      db().transaction(async (tx) => {
        await tx.update(user).set({ rgBlocked: true }).where(eq(user.id, userId));
        await publisher.publish(tx, userId);
      }),
    ).rejects.toThrow('ledger unreachable');

    const [account] = await db().select().from(user).where(eq(user.id, userId));
    expect(account).toMatchObject({ rgBlocked: false, playEligibilityVersion: 0 });
    expect(emitted).toHaveLength(0);
  });

  it('commits a lift first on a remote ledger and leaves the ledger to the event', async () => {
    const userId = await seededUser();
    const { projection, written } = recordingProjection(true);
    const { publisher, emitted } = publisherOver(projection);
    await setBlocked(userId, true);
    await db().transaction((tx) => publisher.publish(tx, userId));
    await setBlocked(userId, false);

    await db().transaction((tx) => publisher.publish(tx, userId));

    expect(written).toHaveLength(1);
    expect(await versionOf(userId)).toBe(2);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({ userId, rgBlocked: false, version: 2 });
  });

  it('writes a lift to a local ledger in the same transaction', async () => {
    const userId = await seededUser();
    const { projection, written } = recordingProjection(false);
    const { publisher } = publisherOver(projection);

    await db().transaction((tx) => publisher.publish(tx, userId));

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ userId, rgBlocked: false });
  });

  it('publishes nothing for a user that does not exist', async () => {
    const { projection, written } = recordingProjection(false);
    const { publisher, emitted } = publisherOver(projection);

    await db().transaction((tx) => publisher.publish(tx, randomUUID()));

    expect(written).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });
});
