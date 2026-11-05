import { eq } from 'drizzle-orm';
import { wallet, walletTransaction, walletWithdrawalAddress } from '../wallet/schema/index.js';
import type { TestDb } from './real-infra.js';

/**
 * Inserts a completed deposit for a user, creating the wallet row when the test
 * has not made one yet. Enough to give the RG limit gate and the monitoring
 * evaluator prior spend to read.
 */
export async function seedCompletedDeposit(
  db: TestDb,
  userId: string,
  amount: string,
  overrides: Partial<typeof walletTransaction.$inferInsert> = {},
) {
  await db.drizzle.db
    .insert(wallet)
    .values({ userId, currency: 'USD' })
    .onConflictDoNothing()
    .returning();
  const [walletRow] = await db.drizzle.db.select().from(wallet).where(eq(wallet.userId, userId));
  if (!walletRow) {
    throw new Error('seedCompletedDeposit: no wallet row for user');
  }
  await db.drizzle.db.insert(walletTransaction).values({
    walletId: walletRow.id,
    type: 'deposit',
    amount,
    currency: 'USD',
    status: 'completed',
    ...overrides,
  });
}

/**
 * Saves a payout address old enough to withdraw to. A withdrawal pays only a saved address that
 * is past its 24-hour wait, so a test that is about something else seeds one instead of walking
 * the address-book route. `network` is whatever the withdrawal resolves to; it is only compared
 * when the asset catalog names one.
 */
export async function seedMatureWithdrawalAddress(
  db: TestDb,
  input: {
    userId: string;
    currency: string;
    address: string;
    network?: string;
    destinationTag?: string;
    ageMs?: number;
  },
) {
  const { ageMs = 25 * 60 * 60 * 1000, network = 'ANY', destinationTag, ...rest } = input;
  await db.drizzle.db
    .insert(walletWithdrawalAddress)
    .values({
      ...rest,
      label: 'Seeded',
      network,
      destinationTag: destinationTag ?? null,
      createdAt: new Date(Date.now() - ageMs),
    })
    .onConflictDoNothing();
}
