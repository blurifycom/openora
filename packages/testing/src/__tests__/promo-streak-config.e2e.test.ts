import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DRIZZLE } from '@openora/core/server';
import { promoStreakConfig } from '@openora/core/promo/schema/gamification';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  readJson,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';

const CONFIG_PATH = '/backoffice/promo/streaks/config';
const CONFIG = {
  currency: 'USD',
  dailyMinWager: '10.000000000000000000',
  eligibleProducts: ['casino', 'sportsbook'],
  milestones: [{ day: 1, rewards: [{ kind: 'cash', amount: '5.000000000000000000' }] }],
  resetAfterDay: 30,
};

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let savedConfig: (typeof promoStreakConfig.$inferSelect)[] = [];

const drizzle = () => app.container.get(DRIZZLE).db;

beforeAll(async () => {
  ({ db, app } = await bootE2e());
  admin = await asAdmin(app.app);
  savedConfig = await drizzle().select().from(promoStreakConfig);
}, 60_000);

afterAll(async () => {
  await drizzle().delete(promoStreakConfig);
  if (savedConfig.length > 0) {
    await drizzle().insert(promoStreakConfig).values(savedConfig);
  }
  await closeE2e({ app, db });
});

describe('an operator choosing which products count toward the streak', () => {
  it('saves the products it names', async () => {
    const res = await admin.put(CONFIG_PATH, CONFIG);

    expect(res.status).toBe(200);
    expect(await readJson(await admin.get(CONFIG_PATH))).toMatchObject({
      eligibleProducts: ['casino', 'sportsbook'],
    });
  });

  it.each([
    ['an empty list', [], ['eligibleProducts'], 'select at least one product'],
    ['a repeated product', ['casino', 'casino'], ['eligibleProducts'], 'products must not repeat'],
    ['an unknown product', ['slots'], ['eligibleProducts', 0], expect.any(String)],
  ])('refuses %s, changing nothing', async (_, eligibleProducts, path, message) => {
    await admin.put(CONFIG_PATH, CONFIG);

    const res = await admin.put(CONFIG_PATH, { ...CONFIG, eligibleProducts });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'BAD_REQUEST',
      data: { issues: [expect.objectContaining({ path, message })] },
    });
    expect(await readJson(await admin.get(CONFIG_PATH))).toMatchObject({
      eligibleProducts: ['casino', 'sportsbook'],
    });
  });
});
