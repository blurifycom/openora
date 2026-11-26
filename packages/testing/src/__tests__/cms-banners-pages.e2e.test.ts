import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import {
  BannerConfigurationSchema,
  BannerConfigurationSummarySchema,
  BannerImageSchema,
  BannerPlacementSummarySchema,
  BannerScheduleSchema,
  PageSchema,
  PublicBannerSchema,
} from '@openora/core/cms/contract';
import { bannerConfiguration, bannerSchedule, page } from '@openora/core/cms/schema';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  flushAudit,
  newPlayer,
  newStaff,
  type E2e,
  type TestClient,
} from '../index.js';
import { ErrorBodySchema } from './support/identity.js';
import { BANNER_IMAGE_HOST } from './support/test-cms-banner-hosts-plugin.js';

let e2e: E2e;
let admin: TestClient;
let playerClient: TestClient;
let readOnlyClient: TestClient;

const HOUR_MS = 3_600_000;

beforeAll(async () => {
  e2e = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'testing-cms-banner-hosts',
        path: fileURLToPath(new URL('./support/test-cms-banner-hosts-plugin.ts', import.meta.url)),
      },
    ],
  });
  admin = await asAdmin(e2e.app.app);
  playerClient = (await newPlayer(e2e.app, 'cms-player')).client;
  readOnlyClient = (await newStaff(e2e.app, 'cms-readonly', 'support-manager')).client;
}, 60_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;
const NullablePublicBannerSchema = PublicBannerSchema.nullable();
const SuccessSchema = z.object({ success: z.literal(true) });
const NotFoundSchema = ErrorBodySchema.extend({ status: z.literal(404) });

const uniquePlacement = () => `e2e-${randomUUID()}`;
const uniqueSlug = () => `e2e-page-${randomUUID()}`;
const imageUrl = () => `https://${BANNER_IMAGE_HOST}/${randomUUID()}.png`;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR_MS).toISOString();

async function createConfiguration(placement: string, layout: 'single' | 'grid' = 'single') {
  const res = await admin.post('/cms/banner-configurations', { placement, layout });
  expect(res.status).toBe(200);
  return BannerConfigurationSchema.parse(await res.json());
}

async function setImage(configurationId: string, overrides: Record<string, unknown> = {}) {
  return admin.put('/cms/banner-images', {
    bannerConfigurationId: configurationId,
    sortOrder: 0,
    desktopImageUrl: imageUrl(),
    mobileImageUrl: imageUrl(),
    ...overrides,
  });
}

async function configurationWithImage(placement: string) {
  const configuration = await createConfiguration(placement);
  const res = await setImage(configuration.id);
  expect(res.status).toBe(200);
  const image = BannerImageSchema.parse(await res.json());
  return { configuration, image };
}

async function setDefault(configurationId: string) {
  const res = await admin.post(`/cms/banner-configurations/${configurationId}/set-default`);
  expect(res.status).toBe(200);
  return BannerPlacementSummarySchema.parse(await res.json());
}

async function publicBanner(placement: string) {
  const res = await playerClient.get(`/cms/banners/${encodeURIComponent(placement)}`);
  expect(res.status).toBe(200);
  return NullablePublicBannerSchema.parse(await res.json());
}

async function createPage(overrides: Record<string, unknown> = {}) {
  return admin.post('/cms/pages', {
    slug: uniqueSlug(),
    title: 'E2E page',
    content: { body: 'hello' },
    ...overrides,
  });
}

async function createdPage(overrides: Record<string, unknown> = {}) {
  const res = await createPage(overrides);
  expect(res.status).toBe(200);
  return PageSchema.parse(await res.json());
}

describe('admin banner placements', () => {
  it("an admin creates a banner configuration for a placement and it appears in that placement's list", async () => {
    const placement = uniquePlacement();
    const configuration = await createConfiguration(placement, 'grid');
    expect(configuration).toMatchObject({
      placement,
      layout: 'grid',
      isDefault: false,
      images: [],
      imageCountBounds: { min: 3, max: 3 },
    });

    const listed = await admin.get(`/cms/banner-placements/${placement}/configurations`);
    expect(listed.status).toBe(200);
    expect(z.array(BannerConfigurationSummarySchema).parse(await listed.json())).toEqual([
      expect.objectContaining({ id: configuration.id, placement, layout: 'grid', imageCount: 0 }),
    ]);
  });

  it('setting a default banner for a placement makes the public banner return it and unsetting removes it', async () => {
    const placement = uniquePlacement();
    const { configuration, image } = await configurationWithImage(placement);
    expect(await publicBanner(placement)).toBeNull();

    const summary = await setDefault(configuration.id);
    expect(summary.defaultConfigurationId).toBe(configuration.id);
    expect(await publicBanner(placement)).toEqual({
      placement,
      layout: 'single',
      slots: [
        {
          sortOrder: 0,
          desktopImageUrl: image.desktopImageUrl,
          mobileImageUrl: image.mobileImageUrl,
          linkUrl: null,
        },
      ],
    });

    const unset = await admin.post(`/cms/banner-placements/${placement}/unset-default`);
    expect(unset.status).toBe(200);
    expect(
      BannerPlacementSummarySchema.parse(await unset.json()).defaultConfigurationId,
    ).toBeNull();
    expect(await publicBanner(placement)).toBeNull();
  });

  it.todo(
    'GAP: setting a banner image within the allowed dimensions and size succeeds - core/src/cms/service/cms.service.ts:746 setBannerImage only validates the URL (https + host allowlist); no width, height or byte-size input or check exists',
  );
  it.todo(
    'GAP: setting a banner image outside the allowed dimensions or size is refused - core/src/cms/contract/index.ts:119 SetBannerImageInputSchema has no dimension or size field and cms.service.ts:746 checks none',
  );

  it('a banner image URL on a host that is not allowed or not https is refused', async () => {
    const configuration = await createConfiguration(uniquePlacement());
    const refusals = [
      `http://${BANNER_IMAGE_HOST}/plain.png`,
      `https://evil-${randomUUID()}.example.com/banner.png`,
      'not a url',
      'javascript:alert(1)',
    ];

    for (const url of refusals) {
      const desktop = await setImage(configuration.id, { desktopImageUrl: url });
      expect(desktop.status).toBe(400);
      const mobile = await setImage(configuration.id, { mobileImageUrl: url });
      expect(mobile.status).toBe(400);
    }

    const stored = await admin.get(`/cms/banner-configurations/${configuration.id}`);
    expect(BannerConfigurationSchema.parse(await stored.json()).images).toEqual([]);
  });

  it('a schedule with an end before its start is refused as invalid range', async () => {
    const placement = uniquePlacement();
    const live = await configurationWithImage(placement);
    await setDefault(live.configuration.id);
    const candidate = await configurationWithImage(placement);

    const inverted = await admin.post(
      `/cms/banner-configurations/${candidate.configuration.id}/schedule`,
      { id: candidate.configuration.id, startsAt: inHours(3), endsAt: inHours(2) },
    );
    expect(inverted.status).toBe(400);
    expect(ErrorBodySchema.parse(await inverted.json()).message).toContain('endsAt must be after');

    const equal = inHours(2);
    const zeroLength = await admin.post(
      `/cms/banner-configurations/${candidate.configuration.id}/schedule`,
      { id: candidate.configuration.id, startsAt: equal, endsAt: equal },
    );
    expect(zeroLength.status).toBe(400);

    const rows = await db()
      .select({ id: bannerSchedule.id })
      .from(bannerSchedule)
      .where(eq(bannerSchedule.bannerConfigurationId, candidate.configuration.id));
    expect(rows).toEqual([]);
  });

  it('a scheduled banner is public only inside its window', async () => {
    const insideWindow = uniquePlacement();
    const insideDefault = await configurationWithImage(insideWindow);
    await setDefault(insideDefault.configuration.id);
    const insideScheduled = await configurationWithImage(insideWindow);
    await db()
      .insert(bannerSchedule)
      .values({
        bannerConfigurationId: insideScheduled.configuration.id,
        startsAt: new Date(Date.now() - HOUR_MS),
        endsAt: new Date(Date.now() + HOUR_MS),
        createdBy: randomUUID(),
      });
    const inside = await publicBanner(insideWindow);
    expect(inside?.slots.map((slot) => slot.desktopImageUrl)).toEqual([
      insideScheduled.image.desktopImageUrl,
    ]);

    const pastWindow = uniquePlacement();
    const pastDefault = await configurationWithImage(pastWindow);
    await setDefault(pastDefault.configuration.id);
    const pastScheduled = await configurationWithImage(pastWindow);
    await db()
      .insert(bannerSchedule)
      .values({
        bannerConfigurationId: pastScheduled.configuration.id,
        startsAt: new Date(Date.now() - 2 * HOUR_MS),
        endsAt: new Date(Date.now() - HOUR_MS),
        createdBy: randomUUID(),
      });
    const past = await publicBanner(pastWindow);
    expect(past?.slots.map((slot) => slot.desktopImageUrl)).toEqual([
      pastDefault.image.desktopImageUrl,
    ]);

    const futureWindow = uniquePlacement();
    const futureDefault = await configurationWithImage(futureWindow);
    await setDefault(futureDefault.configuration.id);
    const futureScheduled = await configurationWithImage(futureWindow);
    const created = await admin.post(
      `/cms/banner-configurations/${futureScheduled.configuration.id}/schedule`,
      { id: futureScheduled.configuration.id, startsAt: inHours(1), endsAt: inHours(2) },
    );
    expect(created.status).toBe(200);
    expect(BannerScheduleSchema.parse(await created.json()).bannerConfigurationId).toBe(
      futureScheduled.configuration.id,
    );
    const future = await publicBanner(futureWindow);
    expect(future?.slots.map((slot) => slot.desktopImageUrl)).toEqual([
      futureDefault.image.desktopImageUrl,
    ]);
  });

  it('deleting or setting the default of an unknown banner returns not found', async () => {
    const unknownId = randomUUID();

    const deleted = await admin.del(`/cms/banner-configurations/${unknownId}`);
    expect(deleted.status).toBe(404);
    NotFoundSchema.parse(await deleted.json());

    const defaulted = await admin.post(`/cms/banner-configurations/${unknownId}/set-default`);
    expect(defaulted.status).toBe(404);
    NotFoundSchema.parse(await defaulted.json());

    const imageDeleted = await admin.del(`/cms/banner-images/${unknownId}`);
    expect(imageDeleted.status).toBe(404);
  });

  it('a non-admin calling any banner write route is refused as forbidden', async () => {
    const placement = uniquePlacement();
    const { configuration, image } = await configurationWithImage(placement);
    const scheduleBody = { id: configuration.id, startsAt: inHours(1), endsAt: inHours(2) };
    const writes = [
      (client: TestClient) =>
        client.post('/cms/banner-configurations', { placement, layout: 'single' }),
      (client: TestClient) => client.del(`/cms/banner-configurations/${configuration.id}`),
      (client: TestClient) =>
        client.post(`/cms/banner-configurations/${configuration.id}/set-default`),
      (client: TestClient) => client.post(`/cms/banner-placements/${placement}/unset-default`),
      (client: TestClient) =>
        client.put('/cms/banner-images', {
          bannerConfigurationId: configuration.id,
          sortOrder: 1,
          desktopImageUrl: imageUrl(),
          mobileImageUrl: imageUrl(),
        }),
      (client: TestClient) => client.del(`/cms/banner-images/${image.id}`),
      (client: TestClient) =>
        client.post(`/cms/banner-configurations/${configuration.id}/schedule`, scheduleBody),
      (client: TestClient) =>
        client.put(`/cms/banner-configurations/${configuration.id}/schedule`, {
          id: configuration.id,
          endsAt: inHours(3),
        }),
    ];

    for (const client of [playerClient, readOnlyClient]) {
      for (const write of writes) {
        expect((await write(client)).status).toBe(403);
      }
    }

    const stored = await admin.get(`/cms/banner-configurations/${configuration.id}`);
    const after = BannerConfigurationSchema.parse(await stored.json());
    expect(after.isDefault).toBe(false);
    expect(after.images.map((row) => row.id)).toEqual([image.id]);
    const configurations = await db()
      .select({ id: bannerConfiguration.id })
      .from(bannerConfiguration)
      .where(eq(bannerConfiguration.placement, placement));
    expect(configurations).toHaveLength(1);
    const schedules = await db()
      .select({ id: bannerSchedule.id })
      .from(bannerSchedule)
      .where(eq(bannerSchedule.bannerConfigurationId, configuration.id));
    expect(schedules).toEqual([]);
  });

  it('the public banner of a placement without any banner returns empty and not an error', async () => {
    const res = await playerClient.get(`/cms/banners/${uniquePlacement()}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });
});

describe('admin pages and publishing', () => {
  it('an admin creates a page and the public page read returns it by slug', async () => {
    const slug = uniqueSlug();
    const created = await createdPage({ slug, title: 'Terms', publishedAt: inHours(-1) });
    expect(created).toMatchObject({ slug, title: 'Terms', content: { body: 'hello' } });

    const read = await playerClient.get(`/cms/pages/${slug}`);
    expect(read.status).toBe(200);
    expect(PageSchema.parse(await read.json())).toMatchObject({
      id: created.id,
      slug,
      title: 'Terms',
      content: { body: 'hello' },
    });

    const listed = await playerClient.get('/cms/pages');
    expect(
      z
        .array(z.object({ id: z.string() }))
        .parse(await listed.json())
        .map((row) => row.id),
    ).toContain(created.id);
  });

  it('an unpublished page is not returned by the public read', async () => {
    const slug = uniqueSlug();
    const created = await createdPage({ slug });
    expect(created.publishedAt).toBeNull();

    const read = await playerClient.get(`/cms/pages/${slug}`);
    expect(read.status).toBe(404);
    NotFoundSchema.parse(await read.json());

    const listed = await playerClient.get('/cms/pages');
    expect(
      z
        .array(z.object({ id: z.string() }))
        .parse(await listed.json())
        .map((row) => row.id),
    ).not.toContain(created.id);
  });

  it('publishing a page makes it public and unpublishing hides it again', async () => {
    const slug = uniqueSlug();
    const created = await createdPage({ slug });
    expect((await playerClient.get(`/cms/pages/${slug}`)).status).toBe(404);

    const published = await admin.put(`/cms/pages/${created.id}`, { publishedAt: inHours(-1) });
    expect(published.status).toBe(200);
    expect((await playerClient.get(`/cms/pages/${slug}`)).status).toBe(200);

    const hidden = await admin.put(`/cms/pages/${created.id}`, { publishedAt: null });
    expect(hidden.status).toBe(200);
    expect(PageSchema.parse(await hidden.json()).publishedAt).toBeNull();
    expect((await playerClient.get(`/cms/pages/${slug}`)).status).toBe(404);
  });

  it.todo(
    'BUG: creating a page with a slug already in use is refused with a conflict - core/src/cms/service/cms.service.ts:310 createPage inserts without mapping the unique violation on page.slug, so the route answers 500 instead of 409',
  );

  it('updating and deleting a page are audited and a deleted page returns not found', async () => {
    const slug = uniqueSlug();
    const created = await createdPage({ slug, publishedAt: inHours(-1) });

    const updated = await admin.put(`/cms/pages/${created.id}`, { title: 'Renamed' });
    expect(updated.status).toBe(200);
    expect(PageSchema.parse(await updated.json()).title).toBe('Renamed');

    const deleted = await admin.del(`/cms/pages/${created.id}`);
    expect(deleted.status).toBe(200);
    expect(SuccessSchema.parse(await deleted.json())).toEqual({ success: true });

    expect((await playerClient.get(`/cms/pages/${slug}`)).status).toBe(404);
    expect((await admin.put(`/cms/pages/${created.id}`, { title: 'Ghost' })).status).toBe(404);
    expect((await admin.del(`/cms/pages/${created.id}`)).status).toBe(404);

    await flushAudit(e2e.app);
    const audit = await db()
      .select({
        action: auditLog.action,
        actorType: auditLog.actorType,
        resourceType: auditLog.resourceType,
      })
      .from(auditLog)
      .where(eq(auditLog.resourceId, created.id));
    expect([...audit].sort((a, b) => a.action.localeCompare(b.action))).toEqual([
      { action: 'admin.content.delete', actorType: 'admin', resourceType: 'content' },
      { action: 'admin.content.update', actorType: 'admin', resourceType: 'content' },
      { action: 'cms.page.created', actorType: 'admin', resourceType: 'page' },
      { action: 'cms.page.deleted', actorType: 'admin', resourceType: 'page' },
      { action: 'cms.page.updated', actorType: 'admin', resourceType: 'page' },
    ]);
  });

  it('a non-admin creating, updating or deleting a page is refused as forbidden', async () => {
    const slug = uniqueSlug();
    const created = await createdPage({ slug, publishedAt: inHours(-1) });

    for (const client of [playerClient, readOnlyClient]) {
      const attemptedSlug = uniqueSlug();
      expect((await client.post('/cms/pages', { slug: attemptedSlug, title: 'Nope' })).status).toBe(
        403,
      );
      expect((await client.put(`/cms/pages/${created.id}`, { title: 'Hijacked' })).status).toBe(
        403,
      );
      expect((await client.del(`/cms/pages/${created.id}`)).status).toBe(403);
      const written = await db()
        .select({ id: page.id })
        .from(page)
        .where(eq(page.slug, attemptedSlug));
      expect(written).toEqual([]);
    }

    const read = await playerClient.get(`/cms/pages/${slug}`);
    expect(PageSchema.parse(await read.json())).toMatchObject({
      id: created.id,
      title: 'E2E page',
    });
    const rows = await db()
      .select({ id: page.id })
      .from(page)
      .where(inArray(page.id, [created.id]));
    expect(rows).toHaveLength(1);
  });
});
