import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { RedisCache } from '@openora/core/server';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import { makeEventBus } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { page as pageTable } from '../schema/index.js';
import { CmsService, PageNotFoundError } from '../service/cms.service.js';

let db: TestDb;
let redis: TestRedis;

function makeService() {
  const events = makeEventBus();
  const cache = new RedisCache(redis.client);
  return { svc: new CmsService(db.drizzle, events, cache), events };
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
  await db.drizzle.db.execute(sql`TRUNCATE ${pageTable} RESTART IDENTITY CASCADE`);
  await redis.flush();
});

describe('CmsService page cache invalidation (real PG + real Redis)', () => {
  it('serves the next getPage from cache, then updatePage invalidates so the reload sees the new row', async () => {
    const { svc } = makeService();
    const created = await svc.createPage(
      { slug: 'about', title: 'About v1', publishedAt: '2024-01-01T00:00:00.000Z' },
      'admin-1',
    );

    // First read populates the read-through cache under the module's key + TTL.
    expect((await svc.getPage('about')).title).toBe('About v1');
    expect(await redis.client.get('cache:cms:page:about')).toContain('About v1');
    const pttl = await redis.client.pTTL('cache:cms:page:about');
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(60_000);

    // A write straight to the DB (bypassing the service) is invisible while the cache holds.
    await db.drizzle.db
      .update(pageTable)
      .set({ title: 'sneaky direct write' })
      .where(eq(pageTable.id, created.id));
    expect((await svc.getPage('about')).title).toBe('About v1');

    // updatePage invalidates the slug key, so the next read reloads from the DB.
    await svc.updatePage({ id: created.id, title: 'About v2' }, 'admin-1');
    expect(await redis.client.get('cache:cms:page:about')).toBeNull();
    expect((await svc.getPage('about')).title).toBe('About v2');
  });
});

describe('CmsService public reads exclude drafts (real SQL)', () => {
  it('getPage 404s a draft slug but returns a published one', async () => {
    const { svc } = makeService();
    await svc.createPage({ slug: 'draft-slug', title: 'Draft' }, 'admin-1');
    await svc.createPage(
      { slug: 'live', title: 'Live', publishedAt: '2024-01-01T00:00:00.000Z' },
      'admin-1',
    );

    await expect(svc.getPage('draft-slug')).rejects.toBeInstanceOf(PageNotFoundError);
    expect((await svc.getPage('live')).title).toBe('Live');
  });

  it('listPages returns only published pages', async () => {
    const { svc } = makeService();
    await svc.createPage({ slug: 'draft-slug', title: 'Draft' }, 'admin-1');
    await svc.createPage(
      { slug: 'live', title: 'Live', publishedAt: '2024-01-01T00:00:00.000Z' },
      'admin-1',
    );

    const pages = await svc.listPages();
    expect(pages.map((p) => p.slug)).toEqual(['live']);
  });
});
