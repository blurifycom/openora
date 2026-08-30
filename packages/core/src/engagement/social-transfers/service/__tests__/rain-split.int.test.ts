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
  it('floors per-recipient rain to the platform money scale, not to cents', async () => {
    const result = await db.drizzle.db.transaction((tx) => calculateRainSplit(tx, '44.44', 3, 3));

    // 44.44 / 3 = 14.81333...(repeating); floored at 18 decimals, not rounded to cents.
    expect(result).toEqual({
      perRecipient: '14.813333333333333333',
      totalDistributed: '44.439999999999999999',
    });
  });

  it('keeps the requested per-recipient amount when fewer users are available', async () => {
    const result = await db.drizzle.db.transaction((tx) => calculateRainSplit(tx, '100', 5, 4));

    expect(result).toEqual({
      perRecipient: '20.000000000000000000',
      totalDistributed: '80.000000000000000000',
    });
  });

  it('rejects a split that would pay zero at the full money scale per recipient', async () => {
    // The smallest representable unit (10^-18) split two ways floors to zero.
    await expect(
      db.drizzle.db.transaction((tx) => calculateRainSplit(tx, '0.000000000000000001', 2, 2)),
    ).rejects.toThrow(TooManyRecipientsError);
  });

  it('splits an 18-decimal crypto amount correctly - old cents-flooring would have zeroed it', async () => {
    // 0.00000005 (a BTC-scale amount) split 3 ways would floor to 0.00 under the old
    // fixed two-decimal step, wrongly throwing TooManyRecipientsError for a legitimate
    // split. Flooring at the full money scale keeps it correct.
    const result = await db.drizzle.db.transaction((tx) =>
      calculateRainSplit(tx, '0.00000005', 3, 3),
    );

    expect(result).toEqual({
      perRecipient: '0.000000016666666666',
      totalDistributed: '0.000000049999999998',
    });
  });
});
