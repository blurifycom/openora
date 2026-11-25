import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { bannerConfiguration } from '@openora/core/cms/schema';
import { adminRole, adminRoleAssignment, adminRolePermission } from '@openora/core/iam/schema';
import { user } from '@openora/core/pam/schema/identity';
import { CREATE_ONLY_CONTENT_ROLE } from './fixtures/test-cms-banner-config-plugin.js';
import {
  asAdmin,
  registerAndMaterializePlayer,
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
  return (await response.json()) as {
    id: string;
    isDefault: boolean;
    layout: string;
    imageCountBounds: { min: number; max: number };
  };
}

async function createOnlyContentAdmin() {
  const drizzle = app.container.get(DRIZZLE).db;
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `content-create-only-${randomUUID()}@example.test`,
  });
  await drizzle.update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  const [role] = await drizzle
    .insert(adminRole)
    .values({ name: CREATE_ONLY_CONTENT_ROLE })
    .returning({ id: adminRole.id });
  await drizzle
    .insert(adminRolePermission)
    .values({ roleId: role!.id, resource: 'content', level: 'read_write' });
  await drizzle.insert(adminRoleAssignment).values({ userId, roleId: role!.id });
  return client;
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

describe('effective image-count bounds on the configuration', () => {
  it('reports the placement override, and the layout default elsewhere', async () => {
    const admin = await asAdmin(app.app);
    const overridden = await createConfiguration(admin, OVERRIDDEN_PLACEMENT, 'carousel');
    const other = await createConfiguration(admin, `no-override-${randomUUID()}`, 'carousel');

    expect(overridden.imageCountBounds).toEqual({ min: 1, max: 6 });
    expect(other.imageCountBounds).toEqual({ min: 2, max: 6 });

    const fetched = await admin.get(`/cms/banner-configurations/${overridden.id}`);
    expect(((await fetched.json()) as { imageCountBounds: unknown }).imageCountBounds).toEqual({
      min: 1,
      max: 6,
    });
  });

  it('keeps the default for a layout the override does not name', async () => {
    const admin = await asAdmin(app.app);
    const single = await createConfiguration(admin, OVERRIDDEN_PLACEMENT, 'single');

    expect(single.imageCountBounds).toEqual({ min: 1, max: 1 });
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

  it('refuses reuse to a caller who may create but not read configurations, and still creates for them', async () => {
    const admin = await asAdmin(app.app);
    const placement = `reuse-authz-${randomUUID()}`;
    const existing = await createConfiguration(admin, placement, 'single');
    const creator = await createOnlyContentAdmin();

    const reuse = await creator.post('/cms/banner-configurations', {
      placement,
      layout: 'single',
      reuseExisting: true,
    });
    expect(reuse.status).toBe(403);
    expect(await rowsFor(placement)).toHaveLength(1);

    const create = await creator.post('/cms/banner-configurations', {
      placement,
      layout: 'single',
    });
    expect(create.status).toBe(200);
    expect(((await create.json()) as { id: string }).id).not.toBe(existing.id);
  });
});
