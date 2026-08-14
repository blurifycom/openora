import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeEventBus } from '../../../testing/mock.js';
import { PlayerKycStatusWriter } from '../service/kyc-status-writer.js';
import { PlayerNotFoundError } from '../service/player.service.js';

let db: TestDb;

function makeWriter() {
  const events = makeEventBus();
  return { writer: new PlayerKycStatusWriter(db.drizzle, events), events };
}

async function seedPlayer(overrides: Partial<typeof player.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ userId: randomUUID(), displayName: 'Player', ...overrides })
    .returning();
  return row!;
}

async function statusOf(userId: string) {
  const [row] = await db.drizzle.db.select().from(player).where(eq(player.userId, userId));
  return row?.kycStatus;
}

beforeAll(async () => {
  db = await createTestDb([migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${player} RESTART IDENTITY CASCADE`);
});

describe('PlayerKycStatusWriter.setStatus (real PG)', () => {
  it('writes the new status and emits the change with its previous value', async () => {
    const { writer, events } = makeWriter();
    const { id: playerId, userId } = await seedPlayer({ kycStatus: 'pending' });
    const actorId = randomUUID();

    await writer.setStatus(userId, 'verified', { actorId, source: 'manual' });

    expect(await statusOf(userId)).toBe('verified');
    expect(events.emit).toHaveBeenCalledWith('compliance.kyc.updated', {
      userId,
      playerId,
      actorId,
      status: 'verified',
      previousStatus: 'pending',
      reason: null,
      source: 'manual',
    });
  });

  it('is a silent no-op when the status is unchanged', async () => {
    const { writer, events } = makeWriter();
    const { userId } = await seedPlayer({ kycStatus: 'verified' });

    await writer.setStatus(userId, 'verified', { actorId: null, source: 'vendor' });

    expect(events.emit).not.toHaveBeenCalled();
  });

  it('throws PlayerNotFoundError for a user with no player profile and emits nothing', async () => {
    const { writer, events } = makeWriter();

    await expect(
      writer.setStatus(randomUUID(), 'verified', { actorId: null, source: 'vendor' }),
    ).rejects.toBeInstanceOf(PlayerNotFoundError);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('leaves other players untouched', async () => {
    const { writer } = makeWriter();
    const target = await seedPlayer({ kycStatus: 'pending' });
    const other = await seedPlayer({ kycStatus: 'pending' });

    await writer.setStatus(target.userId, 'rejected', { actorId: null, source: 'vendor' });

    expect(await statusOf(other.userId)).toBe('pending');
  });

  it('writes on the callers transaction when one is supplied', async () => {
    const { writer, events } = makeWriter();
    const { userId } = await seedPlayer({ kycStatus: 'pending' });

    await db.drizzle.db.transaction(async (tx) => {
      await writer.setStatus(userId, 'verified', { actorId: null, source: 'webhook' }, tx);
    });

    expect(await statusOf(userId)).toBe('verified');
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it('rolls the status back with the callers transaction', async () => {
    const { writer } = makeWriter();
    const { userId } = await seedPlayer({ kycStatus: 'pending' });

    await expect(
      db.drizzle.db.transaction(async (tx) => {
        await writer.setStatus(userId, 'verified', { actorId: null, source: 'webhook' }, tx);
        throw new Error('caller failed after the status write');
      }),
    ).rejects.toThrow('caller failed');

    expect(await statusOf(userId)).toBe('pending');
  });
});
