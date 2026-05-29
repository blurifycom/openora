import { defineConfig, devices } from '@playwright/test';

// E2E against the reference apps: web (player, :3000) and backoffice (admin, :3002),
// both talking to the API (:3001). `global-setup` migrates + seeds the database.
//
// By default we expect the stack to already be running (`pnpm dev` in another
// terminal) and just reuse it. Set E2E_WEBSERVER=1 to let Playwright boot the
// whole stack via `pnpm dev` (turbo starts api + web + backoffice).
const useWebServer = process.env['E2E_WEBSERVER'] === '1';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(useWebServer
    ? {
        webServer: {
          command: 'pnpm --dir .. dev',
          url: 'http://localhost:3000',
          reuseExistingServer: true,
          timeout: 180_000,
        },
      }
    : {}),
});
