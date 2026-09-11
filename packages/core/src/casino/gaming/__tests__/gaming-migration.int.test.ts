import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { game, gameCategory, gameCategoryGame, gameProvider } from '../schema/index.js';

let db: TestDb;

// Matched by migration index (0003/0004/...) so later renames of the random
// drizzle tag suffix never break this file.
function migrationStatements(index: string): string[] {
  const dir = fileURLToPath(new URL('../drizzle/migrations', import.meta.url));
  const [file] = readdirSync(dir)
    .filter((f) => new RegExp(`^${index}_.*\\.sql$`).exec(f))
    .sort();
  if (!file) {
    throw new Error(`migration ${index}_* not found`);
  }
  return readFileSync(`${dir}/${file}`, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function apply(indexes: string[]) {
  for (const index of indexes) {
    for (const stmt of migrationStatements(index)) {
      await db.drizzle.db.execute(sql.raw(stmt));
    }
  }
}

async function nullability(): Promise<Map<string, string>> {
  const cols = (await db.drizzle.db.execute(sql`
    SELECT column_name AS "name", is_nullable AS "nullable"
    FROM information_schema.columns
    WHERE table_name = 'game'
      AND column_name IN ('slug', 'provider_id', 'aggregator', 'provider', 'category')`)) as unknown as {
    rows: Array<{ name: string; nullable: string }>;
  };
  return new Map(cols.rows.map((r) => [r.name, r.nullable]));
}

beforeAll(async () => {
  db = await createTestDb([]);
});

afterAll(async () => {
  await db.drop();
});

describe('gaming catalog migration 0005 (real PG)', () => {
  it('expands, backfills and enforces NOT NULL in one migration, keeping legacy columns', async () => {
    await apply(['0000', '0001', '0002']);
    await db.drizzle.db.execute(sql`
      INSERT INTO "game" ("name", "provider", "category", "is_active") VALUES
        ('Roulette', 'Pragmatic Play', 'Table Games', true),
        ('Roulette', 'NetEnt', 'Slots', true),
        ('Aces', 'ACME', 'Slots', false),
        ('Kings', 'Acme', 'Slots', true)`);

    await apply(['0003', '0004', '0005']);

    const providers = await db.drizzle.db
      .select({ slug: gameProvider.slug, name: gameProvider.name, isActive: gameProvider.isActive })
      .from(gameProvider);
    expect(providers.map((p) => p.slug).sort()).toEqual([
      'acme',
      'acme-2',
      'netent',
      'pragmatic-play',
    ]);
    expect(providers.map((p) => p.name).sort()).toEqual([
      'ACME',
      'Acme',
      'NetEnt',
      'Pragmatic Play',
    ]);
    expect(new Set(providers.map((p) => p.isActive))).toEqual(new Set([true]));

    const games = await db.drizzle.db
      .select({
        name: game.name,
        slug: game.slug,
        providerId: game.providerId,
        aggregator: game.aggregator,
        isActive: game.isActive,
      })
      .from(game);
    expect(games.map((g) => g.slug).sort()).toEqual(['aces', 'kings', 'roulette', 'roulette-2']);
    expect(new Set(games.map((g) => g.aggregator))).toEqual(new Set(['direct']));
    const byName = new Map(games.map((g) => [g.name, g]));
    expect(byName.get('Aces')).toMatchObject({ isActive: false });
    expect(byName.get('Kings')).toMatchObject({ isActive: true });
    const providerNames = await db.drizzle.db
      .select({ slug: game.slug, name: gameProvider.name })
      .from(game)
      .innerJoin(gameProvider, eq(game.providerId, gameProvider.id));
    expect(new Map(providerNames.map((r) => [r.slug, r.name])).get('aces')).toBe('ACME');

    const categories = await db.drizzle.db.select({ slug: gameCategory.slug }).from(gameCategory);
    expect(categories.map((c) => c.slug).sort()).toEqual(['slots', 'table-games']);
    const links = await db.drizzle.db.select().from(gameCategoryGame);
    expect(links).toHaveLength(4);

    const enforced = await nullability();
    expect(enforced.get('slug')).toBe('NO');
    expect(enforced.get('provider_id')).toBe('NO');
    expect(enforced.get('aggregator')).toBe('NO');
    // Legacy columns stay until the follow-up drop migration.
    expect(enforced.get('provider')).toBe('YES');
    expect(enforced.get('category')).toBe('YES');
  });
});
