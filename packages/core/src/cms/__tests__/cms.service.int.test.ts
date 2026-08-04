import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { RedisCache } from '@openora/core/server';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import { makeEventBus } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { page as pageTable, banner as bannerTable } from '../schema/index.js';
import { CmsService, PageNotFoundError } from '../service/cms.service.js';

let db: TestDb;
let redis: TestRedis;

function makeService() {
  const events = makeEventBus();
  const cache = new RedisCache(redis.client);
  return { svc: new CmsService(db.drizzle, events, cache), events };
}

const emittedTopics = (events: ReturnType<typeof makeEventBus>) =>
  events.emit.mock.calls.map(([topic]) => topic);

async function bannerById(id: string) {
  const [row] = await db.drizzle.db.select().from(bannerTable).where(eq(bannerTable.id, id));
  return row;
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
  redis = await createTestRedis();
});

afterAll(async () => {
  await db.drop();
  await redis.quit();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${pageTable}, ${bannerTable} RESTART IDENTITY CASCADE`);
  await redis.flush();
});

describe('CmsService.createPage (real PG)', () => {
  it('emits page.created but not page.published for an unpublished page', async () => {
    const { svc, events } = makeService();

    await svc.createPage({ slug: 'draft', title: 'Draft' }, 'admin-1');

    expect(emittedTopics(events)).toEqual(['cms.page.created']);
  });

  it('emits page.created and page.published when publishedAt is set', async () => {
    const { svc, events } = makeService();

    await svc.createPage(
      { slug: 'live', title: 'Live', publishedAt: '2024-01-01T00:00:00.000Z' },
      'admin-1',
    );

    expect(emittedTopics(events)).toEqual(['cms.page.created', 'cms.page.published']);
  });
});

describe('CmsService.updatePage (real PG + real Redis)', () => {
  it('invalidates both the old and new slug cache keys when the slug changes', async () => {
    const { svc } = makeService();
    const created = await svc.createPage(
      { slug: 'old-slug', title: 'Page', publishedAt: '2024-01-01T00:00:00.000Z' },
      'admin-1',
    );
    await svc.getPage('old-slug');
    expect(await redis.client.get('cache:cms:page:old-slug')).not.toBeNull();

    await svc.updatePage({ id: created.id, slug: 'new-slug' }, 'admin-1');

    expect(await redis.client.get('cache:cms:page:old-slug')).toBeNull();
    expect((await svc.getPage('new-slug')).slug).toBe('new-slug');
  });

  it('emits page.published only on the draft to published transition', async () => {
    const { svc, events } = makeService();
    const published = await svc.createPage(
      { slug: 'already-live', title: 'Page', publishedAt: '2024-01-01T00:00:00.000Z' },
      'admin-1',
    );

    await svc.updatePage({ id: published.id, title: 'Page v2' }, 'admin-1');

    expect(emittedTopics(events)).toEqual([
      'cms.page.created',
      'cms.page.published',
      'cms.page.updated',
    ]);
  });
});

describe('CmsService.deletePage (real PG + real Redis)', () => {
  it('deletes the row, invalidates the cache, and 404s a follow-up getPage', async () => {
    const { svc, events } = makeService();
    const created = await svc.createPage(
      { slug: 'to-delete', title: 'Page', publishedAt: '2024-01-01T00:00:00.000Z' },
      'admin-1',
    );
    await svc.getPage('to-delete');

    await svc.deletePage(created.id, 'admin-1');

    expect(await redis.client.get('cache:cms:page:to-delete')).toBeNull();
    await expect(svc.getPage('to-delete')).rejects.toBeInstanceOf(PageNotFoundError);
    expect(emittedTopics(events)).toEqual([
      'cms.page.created',
      'cms.page.published',
      'cms.page.deleted',
    ]);
  });
});

describe('CmsService banners (real PG + real Redis)', () => {
  it('serves the next listBannersByPlacement from cache until a create invalidates it', async () => {
    const { svc } = makeService();
    await svc.createBanner(
      { placement: 'home-top', title: 'First', imageUrl: 'https://example.com/1.png' },
      'admin-1',
    );
    expect(await svc.listBannersByPlacement('home-top')).toHaveLength(1);
    expect(await redis.client.get('cache:cms:banners:home-top')).not.toBeNull();

    await svc.createBanner(
      { placement: 'home-top', title: 'Second', imageUrl: 'https://example.com/2.png' },
      'admin-1',
    );

    expect(await redis.client.get('cache:cms:banners:home-top')).toBeNull();
    expect(await svc.listBannersByPlacement('home-top')).toHaveLength(2);
  });

  it('invalidates both the old and new placement cache when a banner moves placement', async () => {
    const { svc } = makeService();
    const created = await svc.createBanner(
      { placement: 'home-top', title: 'Banner', imageUrl: 'https://example.com/1.png' },
      'admin-1',
    );
    await svc.listBannersByPlacement('home-top');
    expect(await redis.client.get('cache:cms:banners:home-top')).not.toBeNull();

    await svc.updateBanner({ id: created.id, placement: 'home-bottom' }, 'admin-1');

    expect(await redis.client.get('cache:cms:banners:home-top')).toBeNull();
    expect(await svc.listBannersByPlacement('home-bottom')).toHaveLength(1);
    expect(await svc.listBannersByPlacement('home-top')).toHaveLength(0);
  });

  it('deleteBanner removes the row and invalidates the cache', async () => {
    const { svc } = makeService();
    const created = await svc.createBanner(
      { placement: 'home-top', title: 'Banner', imageUrl: 'https://example.com/1.png' },
      'admin-1',
    );
    await svc.listBannersByPlacement('home-top');

    await svc.deleteBanner(created.id, 'admin-1');

    expect(await bannerById(created.id)).toBeUndefined();
    expect(await redis.client.get('cache:cms:banners:home-top')).toBeNull();
    expect(await svc.listBannersByPlacement('home-top')).toHaveLength(0);
  });

  it('listBanners returns every placement ordered by placement then sortOrder', async () => {
    const { svc } = makeService();
    await svc.createBanner(
      { placement: 'home-top', title: 'B', imageUrl: 'https://example.com/b.png', sortOrder: 2 },
      'admin-1',
    );
    await svc.createBanner(
      { placement: 'home-top', title: 'A', imageUrl: 'https://example.com/a.png', sortOrder: 1 },
      'admin-1',
    );
    await svc.createBanner(
      { placement: 'footer', title: 'C', imageUrl: 'https://example.com/c.png' },
      'admin-1',
    );

    const banners = await svc.listBanners();

    expect(banners.map((b) => b.title)).toEqual(['C', 'A', 'B']);
  });
});
