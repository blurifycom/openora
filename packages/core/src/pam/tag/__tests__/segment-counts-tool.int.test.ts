import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  Container,
  DRIZZLE,
  ModuleRegistryImpl,
  type CoreTokenCatalog,
} from '@openora/core/server';
import type { PlayerStatus, RunContext, TagKey } from '@openora/core/contracts';
import {
  createMcpKernel,
  createTestDb,
  seedPlayerWithUser,
  seedUser,
  type TestDb,
} from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeAuditWriter } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { playerTag, tag } from '../schema/index.js';
import tagPlugin from '../plugin.js';

let db: TestDb;
const DAY_MS = 24 * 60 * 60 * 1000;

function bootKernel() {
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('tag');
  tagPlugin.register(registry);
  return createMcpKernel({
    tools: registry.mcp.getTools(),
    // The module's action types need the event bus; this reads only its tool.
    actions: [],
    container,
    authorize: async () => 'allowed',
    audit: makeAuditWriter(),
  });
}

const runContext = (): RunContext => ({
  runId: randomUUID(),
  actor: { kind: 'agent', agentId: randomUUID(), agentVersion: 1, onBehalfOf: randomUUID() },
  catalogVersion: 'test',
  correlationId: 'segment-counts-tool',
});

async function tagIdFor(key: TagKey) {
  const [existing] = await db.drizzle.db.select().from(tag).where(eq(tag.key, key));
  if (existing) {
    return existing.id;
  }
  const [created] = await db.drizzle.db.insert(tag).values({ key }).returning();
  return created!.id;
}

async function seedPlayer({
  status = 'active',
  deactivated = false,
  tags = [],
  removedTags = [],
  level = 1,
  seenDaysAgo = null,
}: {
  status?: PlayerStatus;
  deactivated?: boolean;
  tags?: TagKey[];
  removedTags?: TagKey[];
  level?: number;
  seenDaysAgo?: number | null;
} = {}) {
  const seeded = await seedPlayerWithUser(db, { status });
  await db.drizzle.db
    .update(player)
    .set({
      level,
      lastSeenAt: seenDaysAgo === null ? null : new Date(Date.now() - seenDaysAgo * DAY_MS),
    })
    .where(eq(player.id, seeded.player.id));
  if (deactivated) {
    await db.drizzle.db.update(user).set({ isActive: false }).where(eq(user.id, seeded.account.id));
  }
  for (const key of [...tags, ...removedTags]) {
    await db.drizzle.db.insert(playerTag).values({
      playerId: seeded.player.id,
      tagId: await tagIdFor(key),
      assignReason: 'seed',
      assignActor: 'manual',
      assignActorUserId: randomUUID(),
      removedAt: removedTags.includes(key) ? new Date() : null,
    });
  }
}

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateProfile, migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${playerTag}, ${tag}, ${player}, ${user} RESTART IDENTITY CASCADE`,
  );
});

describe('players.segment_counts through the MCP kernel (real PG)', () => {
  it('counts the population, each tag and each level, and who of them was seen in the window', async () => {
    const kernel = bootKernel();
    await seedPlayer({ tags: ['vip'], level: 2, seenDaysAgo: 1 });
    await seedPlayer({ removedTags: ['vip'], level: 1, seenDaysAgo: 40 });
    await seedPlayer({ tags: ['vip', 'high_risk'], level: 2 });
    // Outside the population: a closed account, a deactivated login and a staff profile.
    await seedPlayer({ status: 'closed', tags: ['vip'], seenDaysAgo: 1 });
    await seedPlayer({ deactivated: true, tags: ['vip'], seenDaysAgo: 1 });
    const staff = await seedUser(db, { role: 'admin' });
    await db.drizzle.db.insert(player).values({ userId: staff.id, lastSeenAt: new Date() });

    const result = await kernel.invokeTool(
      'players.segment_counts',
      { tagKeys: ['vip', 'high_risk', 'bonus_abuser'], windowDays: 30 },
      runContext(),
    );

    expect(result).toEqual({
      ok: true,
      output: {
        windowDays: 30,
        population: { players: 3, seenInWindow: 1 },
        tags: [
          { tag: 'vip', players: 2, seenInWindow: 1 },
          { tag: 'high_risk', players: 1, seenInWindow: 0 },
          { tag: 'bonus_abuser', players: 0, seenInWindow: 0 },
        ],
        levels: [
          { level: 1, players: 1, seenInWindow: 0 },
          { level: 2, players: 2, seenInWindow: 1 },
        ],
        truncated: false,
      },
    });
  });

  it('counts every tag by default, and refuses a window over 92 days', async () => {
    const kernel = bootKernel();

    const every = await kernel.invokeTool('players.segment_counts', {}, runContext());

    expect(every).toMatchObject({ ok: true, output: { windowDays: 30, tags: expect.any(Array) } });
    expect(every.ok && (every.output as { tags: unknown[] }).tags.length).toBeGreaterThan(10);
    expect(
      await kernel.invokeTool('players.segment_counts', { windowDays: 93 }, runContext()),
    ).toMatchObject({ ok: false, error: 'invalid_input' });
  });
});
