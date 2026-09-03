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
} from '../schema/index.js';
import {
  CmsService,
  PageNotFoundError,
  BannerConfigurationNotFoundError,
  BannerConfigurationIsDefaultError,
  BannerConfigurationImageCountError,
  BannerImageHostNotAllowedError,
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
    sql`TRUNCATE ${pageTable}, ${bannerConfigurationTable}, ${bannerImageTable} RESTART IDENTITY CASCADE`,
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
