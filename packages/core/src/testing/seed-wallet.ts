import { eq } from 'drizzle-orm';
import { wallet, walletTransaction } from '../wallet/schema/index.js';
import type { TestDb } from './real-infra.js';

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
