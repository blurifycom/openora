import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { wallet } from '../schema/index.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

const tipLabels = async () =>
  (
    await db.drizzle.db.execute(
      sql`SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'wallet_transaction_type' AND e.enumlabel = 'tip'`,
    )
  ).rows.length;

describe('wallet migrate guard for the removed tip type', () => {
  it('is a no-op once the enum no longer carries tip', async () => {
    await expect(migrate(db.url)).resolves.toBeUndefined();
  });

  it('passes a database whose enum still carries tip with no tip rows, then refuses one holding a tip row without changing it', async () => {
    await db.drizzle.db.execute(sql`ALTER TYPE wallet_transaction_type ADD VALUE 'tip'`);
    await expect(migrate(db.url)).resolves.toBeUndefined();

    const w = findOneOrThrow(
      await db.drizzle.db
        .insert(wallet)
        .values({ userId: randomUUID(), currency: 'USD' })
        .returning(),
      new Error('seed: no wallet'),
    );
    await db.drizzle.db.execute(
      sql`INSERT INTO wallet_transaction (wallet_id, type, amount, currency, status, rail)
          VALUES (${w.id}, 'tip', '10', 'USD', 'completed', 'fiat')`,
    );

    await expect(migrate(db.url)).rejects.toThrow(
      /1 wallet_transaction row\(s\) have type 'tip'\. This release removes the tip transaction type and ledger rows are immutable\. On a development or test database, reset it before upgrading; on a database holding real money, stay on the previous release\./,
    );

    const rows = await db.drizzle.db.execute(
      sql`SELECT type::text AS type FROM wallet_transaction WHERE wallet_id = ${w.id}`,
    );
    expect(rows.rows).toEqual([{ type: 'tip' }]);
    expect(await tipLabels()).toBe(1);
  });
});
