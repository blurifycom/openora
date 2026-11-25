import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { bannerConfiguration } from '@openora/core/cms/schema';
import {
  asAdmin,
  type TestApp,
  type TestClient,
  type TestDb,
  bootE2e,
  closeE2e,
} from '../index.js';

// The fixture plugin lowers the carousel minimum to 1 for this placement only.
const OVERRIDDEN_PLACEMENT = 'bounds-override';

let db: TestDb;
let app: TestApp;

async function createConfiguration(
  admin: TestClient,
  placement: string,
  layout: 'carousel' | 'single',
  reuseExisting?: boolean,
) {
  const response = await admin.post('/cms/banner-configurations', {
    placement,
    layout,
    ...(reuseExisting === undefined ? {} : { reuseExisting }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; isDefault: boolean; layout: string };
}

async function setImage(admin: TestClient, bannerConfigurationId: string, sortOrder = 0) {
  const response = await admin.request('/cms/banner-images', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      bannerConfigurationId,
      sortOrder,
      desktopImageUrl: `https://img.example.test/${bannerConfigurationId}-${sortOrder}-d.png`,
      mobileImageUrl: `https://img.example.test/${bannerConfigurationId}-${sortOrder}-m.png`,
    }),
  });
  expect(response.status).toBe(200);
}

async function rowsFor(placement: string) {
  return app.container
    .get(DRIZZLE)
    .db.select()
    .from(bannerConfiguration)
    .where(eq(bannerConfiguration.placement, placement));
}

beforeAll(async () => {
  ({ db, app } = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'testing-cms-banner-config',
        path: fileURLToPath(
          new URL('./fixtures/test-cms-banner-config-plugin.ts', import.meta.url),
        ),
      },
    ],
  }));
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('per-placement banner image-count bounds', () => {
  it('lets a one-image carousel go live on the overridden placement', async () => {
    const admin = await asAdmin(app.app);
    const configuration = await createConfiguration(admin, OVERRIDDEN_PLACEMENT, 'carousel');
    await setImage(admin, configuration.id);

    const response = await admin.post(
      `/cms/banner-configurations/${configuration.id}/set-default`,
      {},
    );
    expect(response.status).toBe(200);
  });

  it('still refuses a one-image carousel on any other placement', async () => {
    const admin = await asAdmin(app.app);
    const configuration = await createConfiguration(
      admin,
      `no-override-${randomUUID()}`,
      'carousel',
    );
    await setImage(admin, configuration.id);

    const response = await admin.post(
      `/cms/banner-configurations/${configuration.id}/set-default`,
      {},
    );
    expect(response.status).toBe(409);
  });
});

describe('createBannerConfiguration reuseExisting', () => {
  it('returns one configuration and writes one row for concurrent first creates', async () => {
    const admin = await asAdmin(app.app);
    const placement = `reuse-race-${randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 6 }, () => createConfiguration(admin, placement, 'carousel', true)),
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await rowsFor(placement)).toHaveLength(1);
  });

  it('returns the default configuration, else the newest, and keeps its layout', async () => {
    const admin = await asAdmin(app.app);
    const placement = `reuse-pick-${randomUUID()}`;
    const first = await createConfiguration(admin, placement, 'single');
    const newest = await createConfiguration(admin, placement, 'single');

    const reusedNewest = await createConfiguration(admin, placement, 'carousel', true);
    expect(reusedNewest.id).toBe(newest.id);
    expect(reusedNewest.layout).toBe('single');

    await setImage(admin, first.id);
    const setDefault = await admin.post(`/cms/banner-configurations/${first.id}/set-default`, {});
    expect(setDefault.status).toBe(200);

    const reusedDefault = await createConfiguration(admin, placement, 'single', true);
    expect(reusedDefault.id).toBe(first.id);
    expect(await rowsFor(placement)).toHaveLength(2);
  });

  it('still creates a row per call without the flag', async () => {
    const admin = await asAdmin(app.app);
    const placement = `no-reuse-${randomUUID()}`;

    const results = await Promise.all([
      createConfiguration(admin, placement, 'single'),
      createConfiguration(admin, placement, 'single', false),
    ]);

    expect(new Set(results.map((result) => result.id)).size).toBe(2);
    expect(await rowsFor(placement)).toHaveLength(2);
  });
});
