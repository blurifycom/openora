import { test, expect } from '@playwright/test';
import { SEED } from '../lib/api.js';

// Admin-facing backoffice app (Vite + TanStack Router SPA, :3002).
const BACKOFFICE = process.env['BACKOFFICE_URL'] ?? 'http://localhost:3002';

test.describe('backoffice: admin auth + player management', () => {
  test('admin can sign in and view the players list', async ({ page }) => {
    await page.goto(`${BACKOFFICE}/login`);
    await page.locator('input[type="email"]').fill(SEED.adminEmail);
    await page.locator('input[type="password"]').fill(SEED.adminPassword);
    await page.locator('button[type="submit"]').click();

    // Redirected into the authed shell.
    await expect(page).not.toHaveURL(/\/login$/, { timeout: 10_000 });

    await page.goto(`${BACKOFFICE}/players`);
    // The seeded players should render in a table.
    await expect(page.locator('table').first()).toBeVisible({ timeout: 10_000 });
  });

  test('unauthenticated visit to an authed route bounces to login', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto(`${BACKOFFICE}/players`);
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});
