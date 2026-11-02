import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { migrate as migrateGaming } from '@openora/core/casino/migrate/gaming';
import { makeCache } from '../../testing/mock.js';
import { FinancialAnalyticsService } from '../service/financial-analytics.service.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrateWallet, migrateGaming]);
});

afterAll(() => db.drop());

describe('revenue by product without the sportsbook installed', () => {
  it('reports the casino products and never reads the sportsbook tables', async () => {
    const service = new FinancialAnalyticsService(db.drizzle, makeCache());

    await expect(service.products({})).resolves.toEqual([]);
  });
});
