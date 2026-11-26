import { eq } from 'drizzle-orm';
import { wallet, walletTransaction } from '../wallet/schema/index.js';
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
