import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootE2e, closeE2e, seedMinimal, asAdmin, type E2e } from '../index.js';

let e2e: E2e;

beforeAll(async () => {
  e2e = await bootE2e({ seed: false });
}, 60_000);

afterAll(async () => {
  await closeE2e(e2e ?? {});
});

describe('seeded admin', () => {
  it('logs in with the password of the latest seed run', async () => {
    const email = 'reseed-admin@oss.dev';
    for (const password of ['first-password-1', 'second-password-2']) {
      await seedMinimal(e2e.app.container, {
        playerCount: 0,
        admin: { email, password, name: 'Admin' },
      });
    }

    await expect(
      asAdmin(e2e.app.app, { email, password: 'second-password-2' }),
    ).resolves.toBeDefined();
  });
});
