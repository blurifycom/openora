import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { RedisCache } from '@openora/core/server';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import { makeEventBus } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  page as pageTable,
  bannerConfiguration as bannerConfigurationTable,
  bannerImage as bannerImageTable,
  bannerSchedule as bannerScheduleTable,
} from '../schema/index.js';
import {
  CmsService,
  PageNotFoundError,
  BannerConfigurationNotFoundError,
  BannerConfigurationIsDefaultError,
  BannerConfigurationImageCountError,
  BannerImageHostNotAllowedError,
  BannerConfigurationHasScheduleError,
  BannerScheduleNotFoundError,
  BannerScheduleInvalidRangeError,
  BannerScheduleOverlapError,
} from '../service/cms.service.js';

let db: TestDb;
let redis: TestRedis;

const ALLOWED_IMAGE_HOST = 'img.example.test';
const imageUrl = (path: string) => `https://${ALLOWED_IMAGE_HOST}${path}`;
// banner_configuration.createdBy is a real uuid column - a non-uuid actor id (fine for
// the page tests, which never persist actorId) fails Postgres uuid parsing.
const ADMIN_ID = '99999999-9999-4999-8999-999999999999';

function makeService(allowedBannerImageHosts: readonly string[] = [ALLOWED_IMAGE_HOST]) {
  const events = makeEventBus();
  const cache = new RedisCache(redis.client);
  return { svc: new CmsService(db.drizzle, events, cache, allowedBannerImageHosts), events };
}

const emittedTopics = (events: ReturnType<typeof makeEventBus>) =>
  events.emit.mock.calls.map(([topic]) => topic);

async function configurationById(id: string) {
  const [row] = await db.drizzle.db
    .select()
    .from(bannerConfigurationTable)
    .where(eq(bannerConfigurationTable.id, id));
  return row;
}

async function scheduleByConfigurationId(bannerConfigurationId: string) {
  const [row] = await db.drizzle.db
    .select()
    .from(bannerScheduleTable)
    .where(eq(bannerScheduleTable.bannerConfigurationId, bannerConfigurationId));
  return row;
}

// Sets up a placement's live default so a schedule has something to layer onto.
async function makeDefaultConfiguration(svc: CmsService, placement: string) {
  const created = await svc.createConfiguration({ placement, layout: 'single' }, ADMIN_ID);
  await svc.setBannerImage(
    {
      bannerConfigurationId: created.id,
      sortOrder: 0,
      desktopImageUrl: imageUrl('/default-d.png'),
      mobileImageUrl: imageUrl('/default-m.png'),
    },
    ADMIN_ID,
  );
  await svc.setDefaultConfiguration(created.id, ADMIN_ID);
  return created;
}

// Inserts a schedule row directly, bypassing createBannerSchedule's startsAt-in-the-future
// guard - the only way to test getPublicBanner's read-time activation/expiry without
// waiting on the wall clock.
async function insertScheduleDirect(input: {
  bannerConfigurationId: string;
  startsAt: Date;
  endsAt: Date;
}) {
  const [row] = await db.drizzle.db
    .insert(bannerScheduleTable)
    .values({ ...input, createdBy: ADMIN_ID })
    .returning();
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
  await db.drizzle.db.execute(
    sql`TRUNCATE ${pageTable}, ${bannerConfigurationTable}, ${bannerImageTable}, ${bannerScheduleTable} RESTART IDENTITY CASCADE`,
  );
  await redis.flush();
});

describe('CmsService.createPage (real PG)', () => {
  it('emits page.created but not page.published for an unpublished page', async () => {
    const { svc, events } = makeService();

    await svc.createPage({ slug: 'draft', title: 'Draft' }, ADMIN_ID);

    expect(emittedTopics(events)).toEqual(['cms.page.created']);
  });

  it('emits page.created and page.published when publishedAt is set', async () => {
    const { svc, events } = makeService();

    await svc.createPage(
      { slug: 'live', title: 'Live', publishedAt: '2024-01-01T00:00:00.000Z' },
      ADMIN_ID,
    );

    expect(emittedTopics(events)).toEqual(['cms.page.created', 'cms.page.published']);
  });
});

describe('CmsService.updatePage (real PG + real Redis)', () => {
  it('invalidates both the old and new slug cache keys when the slug changes', async () => {
    const { svc } = makeService();
    const created = await svc.createPage(
      { slug: 'old-slug', title: 'Page', publishedAt: '2024-01-01T00:00:00.000Z' },
      ADMIN_ID,
    );
    await svc.getPage('old-slug');
    expect(await redis.client.get('cache:cms:page:old-slug')).not.toBeNull();

    await svc.updatePage({ id: created.id, slug: 'new-slug' }, ADMIN_ID);

    expect(await redis.client.get('cache:cms:page:old-slug')).toBeNull();
    expect((await svc.getPage('new-slug')).slug).toBe('new-slug');
  });

  it('emits page.published only on the draft to published transition', async () => {
    const { svc, events } = makeService();
    const published = await svc.createPage(
      { slug: 'already-live', title: 'Page', publishedAt: '2024-01-01T00:00:00.000Z' },
      ADMIN_ID,
    );

    await svc.updatePage({ id: published.id, title: 'Page v2' }, ADMIN_ID);

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
      ADMIN_ID,
    );
    await svc.getPage('to-delete');

    await svc.deletePage(created.id, ADMIN_ID);

    expect(await redis.client.get('cache:cms:page:to-delete')).toBeNull();
    await expect(svc.getPage('to-delete')).rejects.toBeInstanceOf(PageNotFoundError);
    expect(emittedTopics(events)).toEqual([
      'cms.page.created',
      'cms.page.published',
      'cms.page.deleted',
    ]);
  });
});

describe('CmsService banner configurations (real PG + real Redis)', () => {
  it('creates, gets, lists, and deletes a configuration', async () => {
    const { svc, events } = makeService();
    const created = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    expect(created).toMatchObject({
      placement: 'home-top',
      layout: 'single',
      isDefault: false,
      images: [],
    });
    expect(emittedTopics(events)).toEqual(['cms.banner.configuration.created']);

    expect(await svc.getConfiguration(created.id)).toMatchObject({ id: created.id, images: [] });

    const list = await svc.listConfigurationsByPlacement('home-top');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: created.id, imageCount: 0 });

    await svc.deleteConfiguration(created.id, ADMIN_ID);

    expect(await configurationById(created.id)).toBeUndefined();
    expect(emittedTopics(events)).toEqual([
      'cms.banner.configuration.created',
      'cms.banner.configuration.deleted',
    ]);
  });

  it('getConfiguration 404s an unknown id', async () => {
    const { svc } = makeService();

    await expect(
      svc.getConfiguration('11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(BannerConfigurationNotFoundError);
  });
});

describe('CmsService.setDefaultConfiguration image-count bounds (real PG)', () => {
  it('rejects a single-layout configuration with zero images, accepts it with one', async () => {
    const { svc } = makeService();
    const created = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );

    await expect(svc.setDefaultConfiguration(created.id, ADMIN_ID)).rejects.toBeInstanceOf(
      BannerConfigurationImageCountError,
    );

    await svc.setBannerImage(
      {
        bannerConfigurationId: created.id,
        sortOrder: 0,
        desktopImageUrl: imageUrl('/d.png'),
        mobileImageUrl: imageUrl('/m.png'),
      },
      ADMIN_ID,
    );

    const summary = await svc.setDefaultConfiguration(created.id, ADMIN_ID);
    expect(summary.defaultConfigurationId).toBe(created.id);
    expect((await configurationById(created.id))?.isDefault).toBe(true);
  });

  it('rejects a grid-layout configuration with too many images', async () => {
    const { svc } = makeService();
    const created = await svc.createConfiguration(
      { placement: 'home-grid', layout: 'grid' },
      ADMIN_ID,
    );
    for (let i = 0; i < 4; i += 1) {
      await svc.setBannerImage(
        {
          bannerConfigurationId: created.id,
          sortOrder: i,
          desktopImageUrl: imageUrl(`/d${i}.png`),
          mobileImageUrl: imageUrl(`/m${i}.png`),
        },
        ADMIN_ID,
      );
    }

    await expect(svc.setDefaultConfiguration(created.id, ADMIN_ID)).rejects.toBeInstanceOf(
      BannerConfigurationImageCountError,
    );
  });
});

describe('CmsService exactly-one-default-per-placement (real PG)', () => {
  it('setting a second configuration as default un-defaults the first', async () => {
    const { svc } = makeService();
    const first = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    await svc.setBannerImage(
      {
        bannerConfigurationId: first.id,
        sortOrder: 0,
        desktopImageUrl: imageUrl('/1d.png'),
        mobileImageUrl: imageUrl('/1m.png'),
      },
      ADMIN_ID,
    );
    await svc.setDefaultConfiguration(first.id, ADMIN_ID);

    const second = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    await svc.setBannerImage(
      {
        bannerConfigurationId: second.id,
        sortOrder: 0,
        desktopImageUrl: imageUrl('/2d.png'),
        mobileImageUrl: imageUrl('/2m.png'),
      },
      ADMIN_ID,
    );
    await svc.setDefaultConfiguration(second.id, ADMIN_ID);

    expect((await configurationById(first.id))?.isDefault).toBe(false);
    expect((await configurationById(second.id))?.isDefault).toBe(true);
  });
});

describe('CmsService.deleteConfiguration blocked-while-default (real PG)', () => {
  it('rejects deleting the placement default, succeeds after unsetting', async () => {
    const { svc } = makeService();
    const created = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    await svc.setBannerImage(
      {
        bannerConfigurationId: created.id,
        sortOrder: 0,
        desktopImageUrl: imageUrl('/d.png'),
        mobileImageUrl: imageUrl('/m.png'),
      },
      ADMIN_ID,
    );
    await svc.setDefaultConfiguration(created.id, ADMIN_ID);

    await expect(svc.deleteConfiguration(created.id, ADMIN_ID)).rejects.toBeInstanceOf(
      BannerConfigurationIsDefaultError,
    );

    await svc.unsetDefaultConfiguration('home-top', ADMIN_ID);
    await svc.deleteConfiguration(created.id, ADMIN_ID);

    expect(await configurationById(created.id)).toBeUndefined();
  });
});

describe('CmsService.setBannerImage upsert (real PG)', () => {
  it('upserts by (bannerConfigurationId, sortOrder, locale) instead of duplicating', async () => {
    const { svc } = makeService();
    const created = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );

    const first = await svc.setBannerImage(
      {
        bannerConfigurationId: created.id,
        sortOrder: 0,
        desktopImageUrl: imageUrl('/d1.png'),
        mobileImageUrl: imageUrl('/m1.png'),
      },
      ADMIN_ID,
    );
    const second = await svc.setBannerImage(
      {
        bannerConfigurationId: created.id,
        sortOrder: 0,
        desktopImageUrl: imageUrl('/d2.png'),
        mobileImageUrl: imageUrl('/m2.png'),
      },
      ADMIN_ID,
    );

    expect(second.id).toBe(first.id);
    const rows = await db.drizzle.db
      .select()
      .from(bannerImageTable)
      .where(eq(bannerImageTable.bannerConfigurationId, created.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.desktopImageUrl).toBe(imageUrl('/d2.png'));
  });

  it('rejects a URL whose host is not in the allow-list', async () => {
    const { svc } = makeService();
    const created = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );

    await expect(
      svc.setBannerImage(
        {
          bannerConfigurationId: created.id,
          sortOrder: 0,
          desktopImageUrl: 'https://evil.example/d.png',
          mobileImageUrl: imageUrl('/m.png'),
        },
        ADMIN_ID,
      ),
    ).rejects.toBeInstanceOf(BannerImageHostNotAllowedError);
  });
});

describe('CmsService.getPublicBanner (real PG + real Redis)', () => {
  it('returns null for a placement with no default configuration', async () => {
    const { svc } = makeService();

    expect(await svc.getPublicBanner('nowhere')).toBeNull();
  });

  it("returns the default configuration's slots", async () => {
    const { svc } = makeService();
    const created = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    await svc.setBannerImage(
      {
        bannerConfigurationId: created.id,
        sortOrder: 0,
        desktopImageUrl: imageUrl('/d.png'),
        mobileImageUrl: imageUrl('/m.png'),
      },
      ADMIN_ID,
    );
    await svc.setDefaultConfiguration(created.id, ADMIN_ID);

    const banner = await svc.getPublicBanner('home-top');

    expect(banner).toMatchObject({
      placement: 'home-top',
      layout: 'single',
      slots: [
        {
          sortOrder: 0,
          desktopImageUrl: imageUrl('/d.png'),
          mobileImageUrl: imageUrl('/m.png'),
          linkUrl: null,
        },
      ],
    });
  });

  it('falls back to the default locale for a slot missing the requested locale', async () => {
    const { svc } = makeService();
    const created = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    await svc.setBannerImage(
      {
        bannerConfigurationId: created.id,
        sortOrder: 0,
        desktopImageUrl: imageUrl('/d.png'),
        mobileImageUrl: imageUrl('/m.png'),
      },
      ADMIN_ID,
    );
    await svc.setDefaultConfiguration(created.id, ADMIN_ID);

    const es = await svc.getPublicBanner('home-top', 'es');

    expect(es?.slots[0]?.desktopImageUrl).toBe(imageUrl('/d.png'));
  });

  it('resolves the requested locale row when present, over the default-locale fallback', async () => {
    const { svc } = makeService();
    const created = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    await svc.setBannerImage(
      {
        bannerConfigurationId: created.id,
        sortOrder: 0,
        desktopImageUrl: imageUrl('/d.png'),
        mobileImageUrl: imageUrl('/m.png'),
      },
      ADMIN_ID,
    );
    await svc.setBannerImage(
      {
        bannerConfigurationId: created.id,
        sortOrder: 0,
        locale: 'es',
        desktopImageUrl: imageUrl('/d-es.png'),
        mobileImageUrl: imageUrl('/m-es.png'),
      },
      ADMIN_ID,
    );
    await svc.setDefaultConfiguration(created.id, ADMIN_ID);

    const es = await svc.getPublicBanner('home-top', 'es');
    const defaultLocale = await svc.getPublicBanner('home-top');

    expect(es?.slots[0]?.desktopImageUrl).toBe(imageUrl('/d-es.png'));
    expect(defaultLocale?.slots[0]?.desktopImageUrl).toBe(imageUrl('/d.png'));
  });
});

describe('CmsService.createBannerSchedule (real PG)', () => {
  it('creates a schedule and emits cms.banner.schedule.created', async () => {
    const { svc, events } = makeService();
    const defaultConfig = await makeDefaultConfiguration(svc, 'home-top');
    const target = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );

    const startsAt = new Date(Date.now() + 60_000).toISOString();
    const endsAt = new Date(Date.now() + 120_000).toISOString();
    const schedule = await svc.createBannerSchedule(target.id, { startsAt, endsAt }, ADMIN_ID);

    expect(schedule).toMatchObject({
      bannerConfigurationId: target.id,
      startsAt,
      endsAt,
      createdBy: ADMIN_ID,
    });
    expect(emittedTopics(events)).toEqual([
      'cms.banner.configuration.created', // defaultConfig
      'cms.banner.image.set',
      'cms.banner.configuration.set_default',
      'cms.banner.configuration.created', // target
      'cms.banner.schedule.created',
    ]);
    const lastEvent = events.emit.mock.calls.at(-1);
    expect(lastEvent?.[1]).toMatchObject({
      bannerScheduleId: schedule.id,
      bannerConfigurationId: target.id,
      placement: 'home-top',
      startsAt,
      endsAt,
      actorId: ADMIN_ID,
    });
    expect(defaultConfig.placement).toBe('home-top');
  });

  it('rejects scheduling the placement default itself', async () => {
    const { svc } = makeService();
    const defaultConfig = await makeDefaultConfiguration(svc, 'home-top');

    await expect(
      svc.createBannerSchedule(
        defaultConfig.id,
        {
          startsAt: new Date(Date.now() + 60_000).toISOString(),
          endsAt: new Date(Date.now() + 120_000).toISOString(),
        },
        ADMIN_ID,
      ),
    ).rejects.toBeInstanceOf(BannerConfigurationIsDefaultError);
  });

  it('rejects scheduling a placement with no default configured yet', async () => {
    const { svc } = makeService();
    const target = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );

    await expect(
      svc.createBannerSchedule(
        target.id,
        {
          startsAt: new Date(Date.now() + 60_000).toISOString(),
          endsAt: new Date(Date.now() + 120_000).toISOString(),
        },
        ADMIN_ID,
      ),
    ).rejects.toBeInstanceOf(BannerConfigurationNotFoundError);
  });

  it('rejects endsAt at or before startsAt', async () => {
    const { svc } = makeService();
    await makeDefaultConfiguration(svc, 'home-top');
    const target = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    const startsAt = new Date(Date.now() + 120_000);
    const endsAt = new Date(Date.now() + 60_000);

    await expect(
      svc.createBannerSchedule(
        target.id,
        { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
        ADMIN_ID,
      ),
    ).rejects.toBeInstanceOf(BannerScheduleInvalidRangeError);
  });

  it('rejects a startsAt that is not in the future', async () => {
    const { svc } = makeService();
    await makeDefaultConfiguration(svc, 'home-top');
    const target = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );

    await expect(
      svc.createBannerSchedule(
        target.id,
        {
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          endsAt: new Date(Date.now() + 60_000).toISOString(),
        },
        ADMIN_ID,
      ),
    ).rejects.toBeInstanceOf(BannerScheduleInvalidRangeError);
  });

  it('rejects a second schedule on a configuration that already has one', async () => {
    const { svc } = makeService();
    await makeDefaultConfiguration(svc, 'home-top');
    const target = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    await svc.createBannerSchedule(
      target.id,
      {
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        endsAt: new Date(Date.now() + 120_000).toISOString(),
      },
      ADMIN_ID,
    );

    await expect(
      svc.createBannerSchedule(
        target.id,
        {
          startsAt: new Date(Date.now() + 200_000).toISOString(),
          endsAt: new Date(Date.now() + 300_000).toISOString(),
        },
        ADMIN_ID,
      ),
    ).rejects.toBeInstanceOf(BannerConfigurationHasScheduleError);
  });

  it('rejects an overlapping schedule on a different configuration in the same placement, naming the conflicting range', async () => {
    const { svc } = makeService();
    await makeDefaultConfiguration(svc, 'home-top');
    const first = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    const second = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    const firstStart = new Date(Date.now() + 60_000);
    const firstEnd = new Date(Date.now() + 180_000);
    await svc.createBannerSchedule(
      first.id,
      { startsAt: firstStart.toISOString(), endsAt: firstEnd.toISOString() },
      ADMIN_ID,
    );

    const overlappingStart = new Date(Date.now() + 120_000);
    const overlappingEnd = new Date(Date.now() + 240_000);
    const error: unknown = await svc
      .createBannerSchedule(
        second.id,
        { startsAt: overlappingStart.toISOString(), endsAt: overlappingEnd.toISOString() },
        ADMIN_ID,
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BannerScheduleOverlapError);
    expect((error as BannerScheduleOverlapError).data).toEqual({
      startsAt: firstStart.toISOString(),
      endsAt: firstEnd.toISOString(),
    });
  });

  it('allows a schedule whose startsAt touches an existing schedule endsAt (boundary-touching is not overlap)', async () => {
    const { svc } = makeService();
    await makeDefaultConfiguration(svc, 'home-top');
    const first = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    const second = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    const firstStart = new Date(Date.now() + 60_000);
    const firstEnd = new Date(Date.now() + 120_000);
    await svc.createBannerSchedule(
      first.id,
      { startsAt: firstStart.toISOString(), endsAt: firstEnd.toISOString() },
      ADMIN_ID,
    );

    const secondSchedule = await svc.createBannerSchedule(
      second.id,
      { startsAt: firstEnd.toISOString(), endsAt: new Date(Date.now() + 180_000).toISOString() },
      ADMIN_ID,
    );

    expect(secondSchedule.startsAt).toBe(firstEnd.toISOString());
  });
});

describe('CmsService.updateBannerScheduleEnd (real PG)', () => {
  it('updates endsAt and emits cms.banner.schedule.updated', async () => {
    const { svc, events } = makeService();
    await makeDefaultConfiguration(svc, 'home-top');
    const target = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    const startsAt = new Date(Date.now() + 60_000);
    await svc.createBannerSchedule(
      target.id,
      { startsAt: startsAt.toISOString(), endsAt: new Date(Date.now() + 120_000).toISOString() },
      ADMIN_ID,
    );

    const newEndsAt = new Date(Date.now() + 90_000).toISOString();
    const updated = await svc.updateBannerScheduleEnd(target.id, { endsAt: newEndsAt }, ADMIN_ID);

    expect(updated.endsAt).toBe(newEndsAt);
    expect((await scheduleByConfigurationId(target.id))?.endsAt.toISOString()).toBe(newEndsAt);
    expect(emittedTopics(events).at(-1)).toBe('cms.banner.schedule.updated');
  });

  it('allows moving endsAt to the past, ending a schedule early', async () => {
    const { svc } = makeService();
    await makeDefaultConfiguration(svc, 'home-top');
    const target = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    const startsAt = new Date(Date.now() - 120_000);
    const endsAt = new Date(Date.now() + 120_000);
    await insertScheduleDirect({ bannerConfigurationId: target.id, startsAt, endsAt });

    const earlyEnd = new Date(Date.now() - 1_000).toISOString();
    const updated = await svc.updateBannerScheduleEnd(target.id, { endsAt: earlyEnd }, ADMIN_ID);

    expect(updated.endsAt).toBe(earlyEnd);
  });

  it('404s a configuration with no attached schedule', async () => {
    const { svc } = makeService();
    await makeDefaultConfiguration(svc, 'home-top');
    const target = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );

    await expect(
      svc.updateBannerScheduleEnd(
        target.id,
        { endsAt: new Date(Date.now() + 60_000).toISOString() },
        ADMIN_ID,
      ),
    ).rejects.toBeInstanceOf(BannerScheduleNotFoundError);
  });

  it('rejects an endsAt at or before the schedule startsAt', async () => {
    const { svc } = makeService();
    await makeDefaultConfiguration(svc, 'home-top');
    const target = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    const startsAt = new Date(Date.now() + 60_000);
    await svc.createBannerSchedule(
      target.id,
      { startsAt: startsAt.toISOString(), endsAt: new Date(Date.now() + 120_000).toISOString() },
      ADMIN_ID,
    );

    await expect(
      svc.updateBannerScheduleEnd(
        target.id,
        { endsAt: new Date(startsAt.getTime() - 1_000).toISOString() },
        ADMIN_ID,
      ),
    ).rejects.toBeInstanceOf(BannerScheduleInvalidRangeError);
  });

  it('re-runs the overlap check excluding self on edit', async () => {
    const { svc } = makeService();
    await makeDefaultConfiguration(svc, 'home-top');
    const first = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    const second = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    const firstStart = new Date(Date.now() + 60_000);
    const firstEnd = new Date(Date.now() + 120_000);
    await svc.createBannerSchedule(
      first.id,
      { startsAt: firstStart.toISOString(), endsAt: firstEnd.toISOString() },
      ADMIN_ID,
    );
    const secondStart = new Date(Date.now() + 200_000);
    await svc.createBannerSchedule(
      second.id,
      { startsAt: secondStart.toISOString(), endsAt: new Date(Date.now() + 260_000).toISOString() },
      ADMIN_ID,
    );

    // Stretching the first schedule's end into the second's start now overlaps it.
    await expect(
      svc.updateBannerScheduleEnd(
        first.id,
        { endsAt: new Date(secondStart.getTime() + 10_000).toISOString() },
        ADMIN_ID,
      ),
    ).rejects.toBeInstanceOf(BannerScheduleOverlapError);

    // Extending the first schedule to touch (not overlap) the second's start is fine -
    // and re-editing the same schedule (excluding itself) does not self-conflict.
    const updated = await svc.updateBannerScheduleEnd(
      first.id,
      { endsAt: secondStart.toISOString() },
      ADMIN_ID,
    );
    expect(updated.endsAt).toBe(secondStart.toISOString());
  });
});

describe('CmsService.listBannerSchedulesByPlacement (real PG)', () => {
  it('lists schedules for a placement ordered by startsAt, with the joined configuration summary', async () => {
    const { svc } = makeService();
    await makeDefaultConfiguration(svc, 'home-top');
    const first = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    const second = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    const laterStart = new Date(Date.now() + 200_000);
    const earlierStart = new Date(Date.now() + 60_000);
    await svc.createBannerSchedule(
      second.id,
      { startsAt: laterStart.toISOString(), endsAt: new Date(Date.now() + 260_000).toISOString() },
      ADMIN_ID,
    );
    await svc.createBannerSchedule(
      first.id,
      {
        startsAt: earlierStart.toISOString(),
        endsAt: new Date(Date.now() + 120_000).toISOString(),
      },
      ADMIN_ID,
    );

    const list = await svc.listBannerSchedulesByPlacement('home-top');

    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      bannerConfigurationId: first.id,
      startsAt: earlierStart.toISOString(),
      configuration: { id: first.id, placement: 'home-top', imageCount: 0 },
    });
    expect(list[1]).toMatchObject({
      bannerConfigurationId: second.id,
      startsAt: laterStart.toISOString(),
    });
  });

  it('returns an empty list for a placement with no schedules', async () => {
    const { svc } = makeService();

    expect(await svc.listBannerSchedulesByPlacement('nowhere')).toEqual([]);
  });
});

describe('CmsService.getPublicBanner schedule resolution (real PG + real Redis)', () => {
  it('prefers an active schedule over the placement default', async () => {
    const { svc } = makeService();
    await makeDefaultConfiguration(svc, 'home-top');
    const scheduled = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    await svc.setBannerImage(
      {
        bannerConfigurationId: scheduled.id,
        sortOrder: 0,
        desktopImageUrl: imageUrl('/scheduled-d.png'),
        mobileImageUrl: imageUrl('/scheduled-m.png'),
      },
      ADMIN_ID,
    );
    await insertScheduleDirect({
      bannerConfigurationId: scheduled.id,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 60_000),
    });

    const banner = await svc.getPublicBanner('home-top');

    expect(banner?.slots[0]?.desktopImageUrl).toBe(imageUrl('/scheduled-d.png'));
  });

  it('falls back to the default once the schedule has expired', async () => {
    const { svc } = makeService();
    await makeDefaultConfiguration(svc, 'home-top');
    const scheduled = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    await svc.setBannerImage(
      {
        bannerConfigurationId: scheduled.id,
        sortOrder: 0,
        desktopImageUrl: imageUrl('/scheduled-d.png'),
        mobileImageUrl: imageUrl('/scheduled-m.png'),
      },
      ADMIN_ID,
    );
    await insertScheduleDirect({
      bannerConfigurationId: scheduled.id,
      startsAt: new Date(Date.now() - 120_000),
      endsAt: new Date(Date.now() - 60_000),
    });

    const banner = await svc.getPublicBanner('home-top');

    expect(banner?.slots[0]?.desktopImageUrl).toBe(imageUrl('/default-d.png'));
  });

  it('falls back to the default before a queued schedule has started', async () => {
    const { svc } = makeService();
    await makeDefaultConfiguration(svc, 'home-top');
    const scheduled = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    await svc.setBannerImage(
      {
        bannerConfigurationId: scheduled.id,
        sortOrder: 0,
        desktopImageUrl: imageUrl('/scheduled-d.png'),
        mobileImageUrl: imageUrl('/scheduled-m.png'),
      },
      ADMIN_ID,
    );
    await insertScheduleDirect({
      bannerConfigurationId: scheduled.id,
      startsAt: new Date(Date.now() + 60_000),
      endsAt: new Date(Date.now() + 120_000),
    });

    const banner = await svc.getPublicBanner('home-top');

    expect(banner?.slots[0]?.desktopImageUrl).toBe(imageUrl('/default-d.png'));
  });
});

describe('CmsService.deleteConfiguration blocked-while-scheduled (real PG)', () => {
  it('rejects deleting a configuration with a queued schedule', async () => {
    const { svc } = makeService();
    await makeDefaultConfiguration(svc, 'home-top');
    const target = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    await svc.createBannerSchedule(
      target.id,
      {
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        endsAt: new Date(Date.now() + 120_000).toISOString(),
      },
      ADMIN_ID,
    );

    await expect(svc.deleteConfiguration(target.id, ADMIN_ID)).rejects.toBeInstanceOf(
      BannerConfigurationHasScheduleError,
    );
  });

  it('rejects deleting a configuration even once its schedule has expired', async () => {
    const { svc } = makeService();
    await makeDefaultConfiguration(svc, 'home-top');
    const target = await svc.createConfiguration(
      { placement: 'home-top', layout: 'single' },
      ADMIN_ID,
    );
    await insertScheduleDirect({
      bannerConfigurationId: target.id,
      startsAt: new Date(Date.now() - 120_000),
      endsAt: new Date(Date.now() - 60_000),
    });

    await expect(svc.deleteConfiguration(target.id, ADMIN_ID)).rejects.toBeInstanceOf(
      BannerConfigurationHasScheduleError,
    );
  });
});
