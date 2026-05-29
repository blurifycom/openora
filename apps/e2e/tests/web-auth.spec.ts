import { test, expect } from '@playwright/test';
import { API, SEED, apiLogin, apiBalance } from '../lib/api.js';

// Player-facing web app (Next.js, :3000).
test.describe('web: player auth + wallet', () => {
  test('login page renders the credential form', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('a seeded player can sign in and reach the wallet page', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[type="email"]').fill(SEED.playerEmail);
    await page.locator('input[type="password"]').fill(SEED.playerPassword);
    await page.locator('button[type="submit"]').click();

    // After login the app redirects off /login.
    await expect(page).not.toHaveURL(/\/login$/, { timeout: 10_000 });

    await page.goto('/wallet');
    await expect(page.getByText(/wallet|balance/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('API: seeded player has a wallet balance', async () => {
    const { userId } = await apiLogin(SEED.playerEmail, SEED.playerPassword);
    const wallet = await apiBalance(userId);
    expect(typeof wallet.balance).toBe('number');
    expect(wallet.currency).toBeTruthy();
  });

  test('API: health endpoint is up', async ({ request }) => {
    const res = await request.get(`${API}/health/ping`);
    expect(res.ok()).toBe(true);
  });
});
