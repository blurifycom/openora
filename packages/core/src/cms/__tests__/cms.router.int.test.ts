import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import { RedisCache } from '@openora/core/server';
import type { AdminGuard } from '@openora/core/server';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import { makeEventBus, makeAdminGuard, testContext } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  page as pageTable,
  bannerConfiguration as bannerConfigurationTable,
  bannerImage as bannerImageTable,
  bannerSchedule as bannerScheduleTable,
} from '../schema/index.js';
import { createCmsRouter } from '../router/index.js';
import { CmsService } from '../service/cms.service.js';

const CTX = testContext();
const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const BANNER_CONFIGURATION_ID = '22222222-2222-4222-8222-222222222222';
const BANNER_IMAGE_ID = '33333333-3333-4333-8333-333333333333';
const ALLOWED_IMAGE_HOST = 'img.example.test';
const imageUrl = (path: string) => `https://${ALLOWED_IMAGE_HOST}${path}`;

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
  await db.drizzle.db.execute(
    sql`TRUNCATE ${pageTable}, ${bannerConfigurationTable}, ${bannerImageTable}, ${bannerScheduleTable} RESTART IDENTITY CASCADE`,
  );
  await redis.flush();
});

function routerWith(adminGuard: AdminGuard) {
  const service = new CmsService(db.drizzle, makeEventBus(), new RedisCache(redis.client), [
    ALLOWED_IMAGE_HOST,
  ]);
  return createCmsRouter(service, adminGuard);
}

function routerWithEvents(adminGuard: AdminGuard) {
  const events = makeEventBus();
  const service = new CmsService(db.drizzle, events, new RedisCache(redis.client), [
    ALLOWED_IMAGE_HOST,
  ]);
  return { router: createCmsRouter(service, adminGuard), events };
}

const denyingGuard = () => makeAdminGuard({ allow: [] });

// banner_configuration.createdBy is a real uuid column - the guard's caller id must be
// a valid uuid for the banner-configuration-writing tests below.
const allowingGuard = () =>
  makeAdminGuard({ caller: { userId: '88888888-8888-4888-8888-888888888888' } });

type Router = ReturnType<typeof createCmsRouter>;

const emittedTopics = (events: ReturnType<typeof makeEventBus>) =>
  events.emit.mock.calls.map(([topic]) => topic);

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
    name: 'listBannerPlacements',
    invoke: (r) => call(r.listBannerPlacements, {}, { context: CTX }),
  },
  {
    name: 'listBannerConfigurationsByPlacement',
    invoke: (r) =>
      call(r.listBannerConfigurationsByPlacement, { placement: 'home' }, { context: CTX }),
  },
  {
    name: 'unsetDefaultBannerConfiguration',
    invoke: (r) => call(r.unsetDefaultBannerConfiguration, { placement: 'home' }, { context: CTX }),
  },
  {
    name: 'getBannerConfiguration',
    invoke: (r) =>
      call(r.getBannerConfiguration, { id: BANNER_CONFIGURATION_ID }, { context: CTX }),
  },
  {
    name: 'createBannerConfiguration',
    invoke: (r) =>
      call(r.createBannerConfiguration, { placement: 'home', layout: 'single' }, { context: CTX }),
  },
  {
    name: 'deleteBannerConfiguration',
    invoke: (r) =>
      call(r.deleteBannerConfiguration, { id: BANNER_CONFIGURATION_ID }, { context: CTX }),
  },
  {
    name: 'setDefaultBannerConfiguration',
    invoke: (r) =>
      call(r.setDefaultBannerConfiguration, { id: BANNER_CONFIGURATION_ID }, { context: CTX }),
  },
  {
    name: 'setBannerImage',
    invoke: (r) =>
      call(
        r.setBannerImage,
        {
          bannerConfigurationId: BANNER_CONFIGURATION_ID,
          sortOrder: 0,
          desktopImageUrl: imageUrl('/d.png'),
          mobileImageUrl: imageUrl('/m.png'),
        },
        { context: CTX },
      ),
  },
  {
    name: 'deleteBannerImage',
    invoke: (r) => call(r.deleteBannerImage, { id: BANNER_IMAGE_ID }, { context: CTX }),
  },
  {
    name: 'createBannerSchedule',
    invoke: (r) =>
      call(
        r.createBannerSchedule,
        {
          id: BANNER_CONFIGURATION_ID,
          startsAt: new Date(Date.now() + 60_000).toISOString(),
          endsAt: new Date(Date.now() + 120_000).toISOString(),
        },
        { context: CTX },
      ),
  },
  {
    name: 'updateBannerScheduleEnd',
    invoke: (r) =>
      call(
        r.updateBannerScheduleEnd,
        { id: BANNER_CONFIGURATION_ID, endsAt: new Date(Date.now() + 120_000).toISOString() },
        { context: CTX },
      ),
  },
  {
    name: 'listBannerSchedulesByPlacement',
    invoke: (r) => call(r.listBannerSchedulesByPlacement, { placement: 'home' }, { context: CTX }),
  },
];

async function storedPages() {
  return db.drizzle.db.select().from(pageTable);
}

async function storedConfigurations() {
  return db.drizzle.db.select().from(bannerConfigurationTable);
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

  it('writes nothing when the guard rejects a banner configuration create', async () => {
    await expect(
      call(
        routerWith(denyingGuard()).createBannerConfiguration,
        { placement: 'home', layout: 'single' },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);

    expect(await storedConfigurations()).toHaveLength(0);
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

describe('cms router banner configuration writes', () => {
  it('creates a configuration, sets an image, and reads it back through the router', async () => {
    const router = routerWith(allowingGuard());
    const created = await call(
      router.createBannerConfiguration,
      { placement: 'home-top', layout: 'single' },
      { context: CTX },
    );

    await call(
      router.setBannerImage,
      {
        bannerConfigurationId: created.id,
        sortOrder: 0,
        desktopImageUrl: imageUrl('/d.png'),
        mobileImageUrl: imageUrl('/m.png'),
      },
      { context: CTX },
    );

    const fetched = await call(router.getBannerConfiguration, { id: created.id }, { context: CTX });
    expect(fetched.images).toHaveLength(1);
  });
});

describe('cms router banner error mapping', () => {
  it('maps deleting the placement default to CONFLICT', async () => {
    const router = routerWith(allowingGuard());
    const created = await call(
      router.createBannerConfiguration,
      { placement: 'home-top', layout: 'single' },
      { context: CTX },
    );
    await call(
      router.setBannerImage,
      {
        bannerConfigurationId: created.id,
        sortOrder: 0,
        desktopImageUrl: imageUrl('/d.png'),
        mobileImageUrl: imageUrl('/m.png'),
      },
      { context: CTX },
    );
    await call(router.setDefaultBannerConfiguration, { id: created.id }, { context: CTX });

    const error: unknown = await call(
      router.deleteBannerConfiguration,
      { id: created.id },
      { context: CTX },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<'deleteBannerConfiguration', unknown>).code).toBe('CONFLICT');
  });

  it('maps setting default with too few images to CONFLICT', async () => {
    const router = routerWith(allowingGuard());
    const created = await call(
      router.createBannerConfiguration,
      { placement: 'home-top', layout: 'single' },
      { context: CTX },
    );

    const error: unknown = await call(
      router.setDefaultBannerConfiguration,
      { id: created.id },
      { context: CTX },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<'setDefaultBannerConfiguration', unknown>).code).toBe('CONFLICT');
  });

  it('maps a disallowed image host to BAD_REQUEST', async () => {
    const router = routerWith(allowingGuard());
    const created = await call(
      router.createBannerConfiguration,
      { placement: 'home-top', layout: 'single' },
      { context: CTX },
    );

    const error: unknown = await call(
      router.setBannerImage,
      {
        bannerConfigurationId: created.id,
        sortOrder: 0,
        desktopImageUrl: 'https://evil.example/d.png',
        mobileImageUrl: imageUrl('/m.png'),
      },
      { context: CTX },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<'setBannerImage', unknown>).code).toBe('BAD_REQUEST');
  });
});

describe('cms router banner events', () => {
  it('emits the six banner domain events with their topic names', async () => {
    const { router, events } = routerWithEvents(allowingGuard());

    const created = await call(
      router.createBannerConfiguration,
      { placement: 'home-top', layout: 'single' },
      { context: CTX },
    );
    const image = await call(
      router.setBannerImage,
      {
        bannerConfigurationId: created.id,
        sortOrder: 0,
        desktopImageUrl: imageUrl('/d.png'),
        mobileImageUrl: imageUrl('/m.png'),
      },
      { context: CTX },
    );
    await call(router.setDefaultBannerConfiguration, { id: created.id }, { context: CTX });
    await call(router.unsetDefaultBannerConfiguration, { placement: 'home-top' }, { context: CTX });
    await call(router.deleteBannerImage, { id: image.id }, { context: CTX });
    await call(router.deleteBannerConfiguration, { id: created.id }, { context: CTX });

    expect(emittedTopics(events)).toEqual([
      'cms.banner.configuration.created',
      'cms.banner.image.set',
      'cms.banner.configuration.set_default',
      'cms.banner.configuration.unset_default',
      'cms.banner.image.deleted',
      'cms.banner.configuration.deleted',
    ]);
  });
});

async function createDefaultConfiguration(router: Router, placement: string) {
  const created = await call(
    router.createBannerConfiguration,
    { placement, layout: 'single' },
    { context: CTX },
  );
  await call(
    router.setBannerImage,
    {
      bannerConfigurationId: created.id,
      sortOrder: 0,
      desktopImageUrl: imageUrl('/d.png'),
      mobileImageUrl: imageUrl('/m.png'),
    },
    { context: CTX },
  );
  await call(router.setDefaultBannerConfiguration, { id: created.id }, { context: CTX });
  return created;
}

describe('cms router banner schedule writes', () => {
  it('creates a schedule, edits its end, and lists it back for the placement', async () => {
    const router = routerWith(allowingGuard());
    await createDefaultConfiguration(router, 'home-top');
    const target = await call(
      router.createBannerConfiguration,
      { placement: 'home-top', layout: 'single' },
      { context: CTX },
    );

    const startsAt = new Date(Date.now() + 60_000).toISOString();
    const endsAt = new Date(Date.now() + 120_000).toISOString();
    const schedule = await call(
      router.createBannerSchedule,
      { id: target.id, startsAt, endsAt },
      { context: CTX },
    );
    expect(schedule).toMatchObject({ bannerConfigurationId: target.id, startsAt, endsAt });

    const newEndsAt = new Date(Date.now() + 90_000).toISOString();
    const updated = await call(
      router.updateBannerScheduleEnd,
      { id: target.id, endsAt: newEndsAt },
      { context: CTX },
    );
    expect(updated.endsAt).toBe(newEndsAt);

    const list = await call(
      router.listBannerSchedulesByPlacement,
      { placement: 'home-top' },
      { context: CTX },
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      bannerConfigurationId: target.id,
      endsAt: newEndsAt,
      configuration: { id: target.id, placement: 'home-top' },
    });
  });
});

describe('cms router banner schedule error mapping', () => {
  it('maps an overlapping schedule to CONFLICT, naming the conflicting range', async () => {
    const router = routerWith(allowingGuard());
    await createDefaultConfiguration(router, 'home-top');
    const first = await call(
      router.createBannerConfiguration,
      { placement: 'home-top', layout: 'single' },
      { context: CTX },
    );
    const second = await call(
      router.createBannerConfiguration,
      { placement: 'home-top', layout: 'single' },
      { context: CTX },
    );
    const firstStart = new Date(Date.now() + 60_000).toISOString();
    const firstEnd = new Date(Date.now() + 180_000).toISOString();
    await call(
      router.createBannerSchedule,
      { id: first.id, startsAt: firstStart, endsAt: firstEnd },
      { context: CTX },
    );

    const error: unknown = await call(
      router.createBannerSchedule,
      {
        id: second.id,
        startsAt: new Date(Date.now() + 120_000).toISOString(),
        endsAt: new Date(Date.now() + 240_000).toISOString(),
      },
      { context: CTX },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<'createBannerSchedule', unknown>).code).toBe('CONFLICT');
    expect(
      (error as ORPCError<'createBannerSchedule', { startsAt: string; endsAt: string }>).data,
    ).toEqual({ startsAt: firstStart, endsAt: firstEnd });
  });

  it('maps endsAt at or before startsAt to BAD_REQUEST', async () => {
    const router = routerWith(allowingGuard());
    await createDefaultConfiguration(router, 'home-top');
    const target = await call(
      router.createBannerConfiguration,
      { placement: 'home-top', layout: 'single' },
      { context: CTX },
    );

    const error: unknown = await call(
      router.createBannerSchedule,
      {
        id: target.id,
        startsAt: new Date(Date.now() + 120_000).toISOString(),
        endsAt: new Date(Date.now() + 60_000).toISOString(),
      },
      { context: CTX },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<'createBannerSchedule', unknown>).code).toBe('BAD_REQUEST');
  });

  it('maps deleting a scheduled configuration to CONFLICT', async () => {
    const router = routerWith(allowingGuard());
    await createDefaultConfiguration(router, 'home-top');
    const target = await call(
      router.createBannerConfiguration,
      { placement: 'home-top', layout: 'single' },
      { context: CTX },
    );
    await call(
      router.createBannerSchedule,
      {
        id: target.id,
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        endsAt: new Date(Date.now() + 120_000).toISOString(),
      },
      { context: CTX },
    );

    const error: unknown = await call(
      router.deleteBannerConfiguration,
      { id: target.id },
      { context: CTX },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<'deleteBannerConfiguration', unknown>).code).toBe('CONFLICT');
  });
});

describe('cms router banner schedule events', () => {
  it('emits cms.banner.schedule.created and cms.banner.schedule.updated', async () => {
    const { router, events } = routerWithEvents(allowingGuard());
    await createDefaultConfiguration(router, 'home-top');
    const target = await call(
      router.createBannerConfiguration,
      { placement: 'home-top', layout: 'single' },
      { context: CTX },
    );

    await call(
      router.createBannerSchedule,
      {
        id: target.id,
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        endsAt: new Date(Date.now() + 120_000).toISOString(),
      },
      { context: CTX },
    );
    await call(
      router.updateBannerScheduleEnd,
      { id: target.id, endsAt: new Date(Date.now() + 90_000).toISOString() },
      { context: CTX },
    );

    expect(emittedTopics(events).slice(-2)).toEqual([
      'cms.banner.schedule.created',
      'cms.banner.schedule.updated',
    ]);
  });
});
