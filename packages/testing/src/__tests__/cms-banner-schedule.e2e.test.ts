import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadExtensions } from '@openora/core/server';
import {
  asAdmin,
  bootTestApp,
  seedMinimal,
  setupTestDb,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';

type BannerConfiguration = { id: string; isDefault: boolean };

let db: TestDb;
let app: TestApp;

async function readJson(res: Response): Promise<unknown> {
  return res.json();
}

function isBannerConfiguration(value: unknown): value is BannerConfiguration {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BannerConfiguration).id === 'string' &&
    typeof (value as BannerConfiguration).isDefault === 'boolean'
  );
}

async function createConfiguration(admin: TestClient, placement: string) {
  const response = await admin.post('/cms/banner-configurations', { placement, layout: 'single' });
  expect(response.status).toBe(200);
  const configuration = await readJson(response);
  if (!isBannerConfiguration(configuration)) {
    throw new Error('expected a banner configuration in the create response');
  }
  return configuration;
}

async function setImage(admin: TestClient, bannerConfigurationId: string) {
  const response = await admin.request('/cms/banner-images', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      bannerConfigurationId,
      sortOrder: 0,
      desktopImageUrl: `https://img.example.test/${bannerConfigurationId}-desktop.png`,
      mobileImageUrl: `https://img.example.test/${bannerConfigurationId}-mobile.png`,
    }),
  });
  expect(response.status).toBe(200);
}

async function createDefaultConfiguration(admin: TestClient, placement: string) {
  const configuration = await createConfiguration(admin, placement);
  await setImage(admin, configuration.id);
  const response = await admin.post(
    `/cms/banner-configurations/${configuration.id}/set-default`,
    {},
  );
  expect(response.status).toBe(200);
  return configuration;
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'testing-cms-banner-config',
        path: fileURLToPath(
          new URL('./fixtures/test-cms-banner-config-plugin.ts', import.meta.url),
        ),
      },
    ],
    databaseUrl: db.url,
  });
  await seedMinimal(app.container, { playerCount: 0 });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('banner default schedule guard', () => {
  it('unsets a default when the placement has no non-expired schedule', async () => {
    const admin = await asAdmin(app.app);
    const placement = `cms-unset-${randomUUID()}`;
    const configuration = await createDefaultConfiguration(admin, placement);

    const unsetResponse = await admin.post(`/cms/banner-placements/${placement}/unset-default`, {});
    expect(unsetResponse.status).toBe(200);

    const configurationResponse = await admin.get(`/cms/banner-configurations/${configuration.id}`);
    expect(configurationResponse.status).toBe(200);
    const updatedConfiguration = await readJson(configurationResponse);
    if (!isBannerConfiguration(updatedConfiguration)) {
      throw new Error('expected a banner configuration in the get response');
    }
    expect(updatedConfiguration.isDefault).toBe(false);
  });

  it('rejects unsetting a default when the placement has a future schedule', async () => {
    const admin = await asAdmin(app.app);
    const placement = `cms-scheduled-${randomUUID()}`;
    const defaultConfiguration = await createDefaultConfiguration(admin, placement);
    const scheduledConfiguration = await createConfiguration(admin, placement);
    await setImage(admin, scheduledConfiguration.id);

    const scheduleResponse = await admin.post(
      `/cms/banner-configurations/${scheduledConfiguration.id}/schedule`,
      {
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        endsAt: new Date(Date.now() + 120_000).toISOString(),
      },
    );
    expect(scheduleResponse.status).toBe(200);

    const unsetResponse = await admin.post(`/cms/banner-placements/${placement}/unset-default`, {});
    expect(unsetResponse.status).toBe(409);

    const configurationResponse = await admin.get(
      `/cms/banner-configurations/${defaultConfiguration.id}`,
    );
    expect(configurationResponse.status).toBe(200);
    const unchangedConfiguration = await readJson(configurationResponse);
    if (!isBannerConfiguration(unchangedConfiguration)) {
      throw new Error('expected a banner configuration in the get response');
    }
    expect(unchangedConfiguration.isDefault).toBe(true);
  });
});
