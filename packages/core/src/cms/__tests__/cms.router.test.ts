import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import { RedisCache } from '@openora/core/server';
import type { AdminGuard } from '@openora/core/server';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import { makeEventBus, makeAdminGuard, testContext } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { page as pageTable, banner as bannerTable } from '../schema/index.js';
import { createCmsRouter } from '../router/index.js';
import { CmsService } from '../service/cms.service.js';

const CTX = testContext();
const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const BANNER_ID = '22222222-2222-4222-8222-222222222222';

let db: TestDb;
let redis: TestRedis;

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

function routerWith(adminGuard: AdminGuard) {
  const service = new CmsService(db.drizzle, makeEventBus(), new RedisCache(redis.client));
  return createCmsRouter(service, adminGuard);
}

const denyingGuard = () => makeAdminGuard({ allow: [] });

const allowingGuard = () => makeAdminGuard({ caller: { userId: 'caller-1' } });

type Router = ReturnType<typeof createCmsRouter>;

const GUARDED_ROUTES: ReadonlyArray<{ name: string; invoke: (r: Router) => Promise<unknown> }> = [
  {
    name: 'createPage',
    invoke: (r) => call(r.createPage, { slug: 'about', title: 'About' }, { context: CTX }),
  },
  {
    name: 'updatePage',
    invoke: (r) => call(r.updatePage, { id: PAGE_ID, title: 'About v2' }, { context: CTX }),
  },
  { name: 'deletePage', invoke: (r) => call(r.deletePage, { id: PAGE_ID }, { context: CTX }) },
  {
    name: 'createBanner',
    invoke: (r) =>
      call(
        r.createBanner,
        { placement: 'home', title: 'Promo', imageUrl: 'https://example.test/a.png' },
        { context: CTX },
      ),
  },
  {
    name: 'updateBanner',
    invoke: (r) => call(r.updateBanner, { id: BANNER_ID, title: 'Promo v2' }, { context: CTX }),
  },
  {
    name: 'deleteBanner',
    invoke: (r) => call(r.deleteBanner, { id: BANNER_ID }, { context: CTX }),
  },
];

async function storedPages() {
  return db.drizzle.db.select().from(pageTable);
}

describe('cms router authz', () => {
  it.each(GUARDED_ROUTES)('rejects $name for a non-privileged caller', async ({ invoke }) => {
    await expect(invoke(routerWith(denyingGuard()))).rejects.toBeInstanceOf(ORPCError);
  });

  it('writes nothing when the guard rejects a create', async () => {
    await expect(
      call(
        routerWith(denyingGuard()).createPage,
        { slug: 'about', title: 'About' },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);

    expect(await storedPages()).toHaveLength(0);
  });
});

describe('cms router admin writes', () => {
  it('createPage persists the page and returns it', async () => {
    const result = await call(
      routerWith(allowingGuard()).createPage,
      { slug: 'about', title: 'About' },
      { context: CTX },
    );

    expect(result).toMatchObject({ slug: 'about', title: 'About' });
    const stored = await storedPages();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.slug).toBe('about');
  });

  it('updatePage writes the new title through to the row', async () => {
    const router = routerWith(allowingGuard());
    const created = await call(
      router.createPage,
      { slug: 'about', title: 'About' },
      { context: CTX },
    );

    await call(router.updatePage, { id: created.id, title: 'About v2' }, { context: CTX });

    expect((await storedPages())[0]?.title).toBe('About v2');
  });

  it('deletePage removes the row', async () => {
    const router = routerWith(allowingGuard());
    const created = await call(
      router.createPage,
      { slug: 'about', title: 'About' },
      { context: CTX },
    );

    await call(router.deletePage, { id: created.id }, { context: CTX });

    expect(await storedPages()).toHaveLength(0);
  });

  it('rejects a duplicate slug rather than shadowing the first page', async () => {
    const router = routerWith(allowingGuard());
    await call(router.createPage, { slug: 'about', title: 'About' }, { context: CTX });

    await expect(
      call(router.createPage, { slug: 'about', title: 'Another' }, { context: CTX }),
    ).rejects.toThrow();
    expect(await storedPages()).toHaveLength(1);
  });
});
