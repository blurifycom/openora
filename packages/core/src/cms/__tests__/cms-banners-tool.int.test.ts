import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  Container,
  DRIZZLE,
  ModuleRegistryImpl,
  findOneOrThrow,
  type CoreTokenCatalog,
} from '@openora/core/server';
import type { RunContext } from '@openora/core/contracts';
import { createMcpKernel, createTestDb, type TestDb } from '@openora/core/testing';
import { makeAuditWriter } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { bannerConfiguration, bannerImage, bannerSchedule } from '../schema/index.js';
import type { BannerLayout } from '../contract/index.js';
import cmsPlugin from '../plugin.js';

let db: TestDb;

const HOUR_MS = 60 * 60 * 1000;
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * HOUR_MS);
const AUTHOR = randomUUID();
const IMAGE_URL = 'https://cdn.example/secret-campaign.png';

function bootKernel() {
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('cms');
  cmsPlugin.register(registry);
  return createMcpKernel({
    tools: registry.mcp.getTools(),
    actions: registry.actions.getAll(),
    container,
    authorize: async () => 'allowed',
    audit: makeAuditWriter(),
  });
}

const runContext = (): RunContext => ({
  runId: randomUUID(),
  actor: { kind: 'agent', agentId: randomUUID(), agentVersion: 1, onBehalfOf: randomUUID() },
  catalogVersion: 'test',
  correlationId: 'cms-banners-tool',
});

async function seedConfiguration(
  placement: string,
  values: { layout?: BannerLayout; isDefault?: boolean; createdAt?: Date } = {},
) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(bannerConfiguration)
      .values({ placement, layout: 'single', createdBy: AUTHOR, ...values })
      .returning(),
    new Error('seedConfiguration: no row'),
  );
}

async function seedImages(bannerConfigurationId: string, slots: [number, string][]) {
  await db.drizzle.db.insert(bannerImage).values(
    slots.map(([sortOrder, locale]) => ({
      bannerConfigurationId,
      sortOrder,
      locale,
      desktopImageUrl: IMAGE_URL,
      mobileImageUrl: IMAGE_URL,
      linkUrl: '/promotions/secret',
    })),
  );
}

async function schedule(bannerConfigurationId: string, startsAt: Date, endsAt: Date) {
  await db.drizzle.db
    .insert(bannerSchedule)
    .values({ bannerConfigurationId, startsAt, endsAt, createdBy: AUTHOR });
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${bannerSchedule}, ${bannerImage}, ${bannerConfiguration} RESTART IDENTITY CASCADE`,
  );
});

describe('cms.banners through the MCP kernel (real PG)', () => {
  it('names what each placement shows now: a covering schedule wins over the default', async () => {
    const kernel = bootKernel();
    const homeDefault = await seedConfiguration('home', { layout: 'carousel', isDefault: true });
    const homeSeasonal = await seedConfiguration('home', { createdAt: hoursFromNow(-2) });
    const homeLater = await seedConfiguration('home', { createdAt: hoursFromNow(-3) });
    const lobbyDefault = await seedConfiguration('lobby', { isDefault: true });
    const lobbyDraft = await seedConfiguration('lobby', { layout: 'grid' });
    await seedImages(homeDefault.id, [
      [0, 'default'],
      [1, 'default'],
      [0, 'de'],
    ]);
    await schedule(homeSeasonal.id, hoursFromNow(-1), hoursFromNow(24));
    const startsAt = hoursFromNow(48);
    await schedule(homeLater.id, startsAt, hoursFromNow(72));

    const result = await kernel.invokeTool('cms.banners', {}, runContext());

    expect(result).toEqual({
      ok: true,
      output: {
        banners: [
          {
            bannerId: homeDefault.id,
            placement: 'home',
            layout: 'carousel',
            isDefault: true,
            imageCount: 3,
            locales: ['de', 'default'],
            liveNow: false,
            nextStartsAt: null,
          },
          expect.objectContaining({ bannerId: homeSeasonal.id, liveNow: true, nextStartsAt: null }),
          expect.objectContaining({
            bannerId: homeLater.id,
            liveNow: false,
            nextStartsAt: startsAt.toISOString(),
          }),
          expect.objectContaining({ bannerId: lobbyDefault.id, liveNow: true, imageCount: 0 }),
          expect.objectContaining({ bannerId: lobbyDraft.id, liveNow: false, locales: [] }),
        ],
        truncated: false,
      },
    });
    const served = JSON.stringify(result);
    for (const hidden of [IMAGE_URL, '/promotions/secret', AUTHOR]) {
      expect(served).not.toContain(hidden);
    }
  });

  it('narrows to one placement, and lets the default show once a schedule has ended', async () => {
    const kernel = bootKernel();
    const homeDefault = await seedConfiguration('home', { isDefault: true });
    const ended = await seedConfiguration('home');
    await schedule(ended.id, hoursFromNow(-48), hoursFromNow(-24));
    await seedConfiguration('lobby', { isDefault: true });

    const result = await kernel.invokeTool('cms.banners', { placement: 'home' }, runContext());

    expect(result).toEqual({
      ok: true,
      output: {
        banners: [
          expect.objectContaining({ bannerId: homeDefault.id, liveNow: true }),
          expect.objectContaining({ bannerId: ended.id, liveNow: false, nextStartsAt: null }),
        ],
        truncated: false,
      },
    });
  });
});
