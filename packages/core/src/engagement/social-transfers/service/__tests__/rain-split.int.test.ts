import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../../migrate.js';
import { calculateRainSplit, TooManyRecipientsError } from '../social-transfers.service.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db?.drop();
});

describe('calculateRainSplit', () => {
  it('floors per-recipient rain to cents in real Postgres', async () => {
    const result = await db.drizzle.db.transaction((tx) => calculateRainSplit(tx, '44.44', 3, 3));

    expect(result).toEqual({
      perRecipient: '14.8100000000000000',
      totalDistributed: '44.4300000000000000',
    });
  });

  it('keeps the requested per-recipient amount when fewer users are available', async () => {
    const result = await db.drizzle.db.transaction((tx) => calculateRainSplit(tx, '100', 5, 4));

    expect(result).toEqual({
      perRecipient: '20.0000000000000000',
      totalDistributed: '80.0000000000000000',
    });
  });

  it('rejects a split that would pay zero cents per recipient', async () => {
    await expect(
      db.drizzle.db.transaction((tx) => calculateRainSplit(tx, '0.01', 2, 2)),
    ).rejects.toThrow(TooManyRecipientsError);
  });
});
