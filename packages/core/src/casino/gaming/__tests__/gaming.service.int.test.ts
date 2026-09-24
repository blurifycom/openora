import * as z from 'zod';
import { createGameSortCatalog, defineGameSort } from '@openora/core/contracts';
import { GameSortService } from '../service/game-sort.service.js';
import { GameSortRankingService } from '../service/game-sort-ranking.service.js';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type {
  GameAdapter,
  GameGeoCheckPort,
  PlayEligibilityPort,
  RgLimitsPort,
  WalletCommands,
  WalletCreditOutcome,
  WalletDebitOutcome,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate as migrateCompliance } from '@openora/core/compliance/migrate';
import { gameGeoRule, providerGeoRule } from '@openora/core/compliance/schema';
import { mock, makeEventBus, makeIdentityReader, NO_CLIENT_META } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  game,
  gameCategory,
  gameCategoryGame,
  gameProvider,
  gameProviderAggregatorMapping,
  gameRound,
  gameTag,
  gameTagGame,
} from '../schema/index.js';
import {
  GamingService,
  GameAggregatorNotMappedError,
  GameNotFoundError,
  GameSlugTakenError,
  RgRestrictedError,
  InsufficientBalanceError,
  WinCreditFailedError,
  ExternalRoundOwnerMismatchError,
  GameGeoFiltersUnavailableError,
} from '../service/gaming.service.js';
import { GameProviderNotFoundError } from '../service/game-provider.service.js';
import { ListAdminGamesInputSchema } from '../contract/index.js';
import { GameCategoryNotFoundError } from '../service/game-category.service.js';
import { GameTagNotFoundError } from '../service/game-tag.service.js';

let db: TestDb;

const noopEvents = makeEventBus();

const ACTOR = { actorId: '00000000-0000-4000-8000-000000000001', ...NO_CLIENT_META };

const eligibility = (isRestricted: boolean) =>
  mock<PlayEligibilityPort>({ isRestricted: vi.fn().mockResolvedValue(isRestricted) });

const unrestricted = eligibility(false);

function makeWalletCommands(
  debitResult: WalletDebitOutcome,
  creditResult: WalletCreditOutcome = { ok: true, moved: false, newBalance: '0' },
): WalletCommands {
  return mock<WalletCommands>({
    debit: vi.fn().mockResolvedValue(debitResult),
    credit: vi.fn().mockResolvedValue(creditResult),
  });
}

function makeService({
  provider = mock<GameAdapter>({
    launchGame: vi.fn().mockResolvedValue({ launchUrl: 'https://mock/play', token: 'tok' }),
    endRound: vi.fn(),
  }),
  playEligibility = unrestricted,
  walletCommands = makeWalletCommands({ ok: true, moved: false, newBalance: '0', currency: 'USD' }),
  rgLimits,
  gameGeoCheck,
  events = noopEvents,
}: {
  provider?: GameAdapter;
  playEligibility?: PlayEligibilityPort;
  walletCommands?: WalletCommands;
  rgLimits?: RgLimitsPort;
  gameGeoCheck?: GameGeoCheckPort;
  events?: ReturnType<typeof makeEventBus>;
} = {}) {
  return new GamingService(
    db.drizzle,
    events,
    provider,
    playEligibility,
    walletCommands,
    makeIdentityReader(),
    rgLimits,
    gameGeoCheck,
  );
}

function startRound(
  svc: GamingService,
  userId: string,
  gameId: string,
  currency: string,
  betAmount: string,
) {
  return svc.startRound(userId, gameId, currency, betAmount, '1.2.3.4');
}

async function seedProvider(overrides: Partial<typeof gameProvider.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameProvider)
    .values({ slug: `studio-${randomUUID()}`, name: 'Studio', isActive: true, ...overrides })
    .returning();
  await db.drizzle.db
    .insert(gameProviderAggregatorMapping)
    .values({ providerId: row!.id, aggregator: 'direct', vendorId: row!.slug });
  return row!;
}

async function seedCategory(overrides: Partial<typeof gameCategory.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameCategory)
    .values({ slug: `category-${randomUUID()}`, name: 'Slots', ...overrides })
    .returning();
  return row!;
}

async function seedTag(overrides: Partial<typeof gameTag.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameTag)
    .values({ name: `Tag ${randomUUID()}`, ...overrides })
    .returning();
  return row!;
}

async function seedGame(overrides: Partial<typeof game.$inferInsert> = {}, categoryIds?: string[]) {
  const provider = await seedProvider({ name: 'Mock Studio' });
  const ids = categoryIds ?? [(await seedCategory()).id];
  const [row] = await db.drizzle.db
    .insert(game)
    .values({
      name: 'Game',
      slug: `game-${randomUUID()}`,
      providerId: provider.id,
      aggregator: 'direct',
      isActive: true,
      ...overrides,
    })
    .returning();
  if (ids.length > 0) {
    await db.drizzle.db
      .insert(gameCategoryGame)
      .values(ids.map((categoryId) => ({ gameId: row!.id, categoryId })));
  }
  return row!;
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile, migrateCompliance]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${gameGeoRule}, ${providerGeoRule}, ${gameRound}, ${gameCategoryGame}, ${gameTagGame}, ${game}, ${gameProvider}, ${gameCategory}, ${gameTag} RESTART IDENTITY CASCADE`,
  );
});

describe('GamingService lobby (real PG)', () => {
  it('listGamesPublic paginates playable games ordered by name', async () => {
    await seedGame({ name: 'Baccarat', isActive: true });
    await seedGame({ name: 'Aces', isActive: true });
    await seedGame({ name: 'Retired', isActive: false });

    const page = await makeService().listGamesPublic({ page: 1, limit: 10 });

    expect(page.total).toBe(2);
    expect(page.items.map((g) => g.name)).toEqual(['Aces', 'Baccarat']);
  });

  it('listGamesPublic searches and filters by provider and category', async () => {
    const p1 = await seedProvider({ slug: 'studio-one', name: 'One' });
    const p2 = await seedProvider({ slug: 'studio-two', name: 'Two' });
    const slots = await seedCategory({ slug: 'slots', name: 'Slots' });
    const live = await seedCategory({ slug: 'live', name: 'Live' });
    await seedGame(
      { name: 'Gates of Olympus', slug: 'gates-of-olympus', providerId: p1.id, isActive: true },
      [slots.id],
    );
    await seedGame(
      { name: 'Sweet Bonanza', slug: 'sweet-bonanza', providerId: p1.id, isActive: true },
      [slots.id],
    );
    await seedGame({ name: 'Crazy Time', slug: 'crazy-time', providerId: p2.id, isActive: true }, [
      live.id,
      slots.id,
    ]);
    const svc = makeService();

    expect((await svc.listGamesPublic({ page: 1, limit: 10, q: 'bonanza' })).total).toBe(1);
    expect(
      (await svc.listGamesPublic({ page: 1, limit: 10, providerId: p1.id })).items.map(
        (g) => g.slug,
      ),
    ).toEqual(['gates-of-olympus', 'sweet-bonanza']);
    expect((await svc.listGamesPublic({ page: 1, limit: 10, categoryId: live.id })).total).toBe(1);
    expect((await svc.listGamesPublic({ page: 1, limit: 10, categoryId: slots.id })).total).toBe(3);
  });

  it('hides an inactive category from public filtering while retaining admin filtering', async () => {
    const inactive = await seedCategory({ name: 'Hidden', isActive: false });
    const linked = await seedGame({ name: 'Linked Game' }, [inactive.id]);
    const svc = makeService();

    const publicResult = await svc.listGamesPublic({
      page: 1,
      limit: 10,
      categoryId: inactive.id,
    });
    expect(publicResult).toMatchObject({ items: [], total: 0 });

    const adminResult = await svc.listGamesAdmin({
      page: 1,
      limit: 10,
      categoryId: inactive.id,
      isActive: true,
    });
    expect(adminResult.items.map((item) => item.id)).toEqual([linked.id]);
    expect(adminResult.total).toBe(1);
  });

  it('getGame returns the row for a known id and 404s an unknown one', async () => {
    const table = await seedCategory({
      slug: 'table-games',
      name: 'Table Games',
      translations: { de: { name: 'Tischspiele' } },
    });
    const blackjack = await seedCategory({ slug: 'blackjack', name: 'Blackjack', isActive: false });
    const created = await seedGame({ name: 'Roulette' }, [table.id, blackjack.id]);
    const svc = makeService();

    expect(await svc.getGame(created.id)).toMatchObject({
      name: 'Roulette',
      categories: [
        { slug: 'blackjack', translations: {} },
        { slug: 'table-games', translations: { de: { name: 'Tischspiele' } } },
      ],
    });
    await expect(svc.getGame(created.id, { activeOnly: true })).resolves.toMatchObject({
      categories: [{ slug: 'table-games' }],
    });
    await expect(svc.getGame('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(
      GameNotFoundError,
    );
  });

  it('getGame hides inactive games and deactivated providers only behind activeOnly', async () => {
    const dark = await seedGame({ name: 'Dark', isActive: false });
    const orphaned = await seedGame({ name: 'Orphaned' });
    await db.drizzle.db
      .update(gameProvider)
      .set({ isActive: false })
      .where(eq(gameProvider.id, orphaned.providerId));
    const svc = makeService();

    await expect(svc.getGame(dark.id, { activeOnly: true })).rejects.toBeInstanceOf(
      GameNotFoundError,
    );
    await expect(svc.getGame(orphaned.id, { activeOnly: true })).rejects.toBeInstanceOf(
      GameNotFoundError,
    );
    await expect(svc.getGame(dark.id)).resolves.toMatchObject({ name: 'Dark', isActive: false });
    await expect(svc.getGame(orphaned.id)).resolves.toMatchObject({ name: 'Orphaned' });
  });

  it('returns visible tags publicly and all tags to admin callers', async () => {
    const visible = await seedTag({ name: 'Visible', visibility: 'visible' });
    const invisible = await seedTag({ name: 'Invisible', visibility: 'invisible' });
    const created = await seedGame();
    await db.drizzle.db.insert(gameTagGame).values([
      { gameId: created.id, tagId: visible.id },
      { gameId: created.id, tagId: invisible.id },
    ]);
    const svc = makeService();

    await expect(svc.getGame(created.id)).resolves.toMatchObject({
      tags: [{ name: 'Visible', visibility: 'visible' }],
    });
    await expect(svc.getGame(created.id, { includeInvisibleTags: true })).resolves.toMatchObject({
      tags: [
        { name: 'Invisible', visibility: 'invisible' },
        { name: 'Visible', visibility: 'visible' },
      ],
    });
  });
});

const refusingLimits = () =>
  mock<RgLimitsPort>({
    checkDeposit: vi.fn(),
    checkWager: vi.fn().mockResolvedValue({
      allowed: false,
      limitType: 'wager',
      period: 'daily',
      limit: '50',
      used: '45',
    }),
  });

describe('GamingService.startRound (real PG)', () => {
  it('denies a blocked game before debit, round insertion, or provider launch', async () => {
    const created = await seedGame({ name: 'Blocked' });
    const launchGame = vi.fn();
    const walletCommands = makeWalletCommands({
      ok: true,
      moved: false,
      newBalance: '90',
      currency: 'USD',
    });
    const gameGeoCheck = mock<GameGeoCheckPort>({
      checkGame: vi.fn().mockResolvedValue({
        allowed: false,
        countryCode: 'US',
        reason: 'game_block',
      }),
    });
    const svc = makeService({
      provider: mock<GameAdapter>({ launchGame, endRound: vi.fn() }),
      walletCommands,
      gameGeoCheck,
    });

    await expect(
      startRound(svc, '00000000-0000-0000-0000-000000000110', created.id, 'USD', '10'),
    ).rejects.toMatchObject({
      name: 'GameGeoRestrictedError',
      data: { reason: 'game_block', countryCode: 'US' },
    });
    expect(walletCommands.debit).not.toHaveBeenCalled();
    expect(launchGame).not.toHaveBeenCalled();
    expect(await db.drizzle.db.select().from(gameRound)).toHaveLength(0);
  });

  it('does not consult geo for an inactive game', async () => {
    const created = await seedGame({ name: 'Inactive', isActive: false });
    const checkGame = vi.fn();
    const svc = makeService({ gameGeoCheck: mock<GameGeoCheckPort>({ checkGame }) });

    await expect(
      startRound(svc, '00000000-0000-0000-0000-000000000110', created.id, 'USD', '10'),
    ).rejects.toBeInstanceOf(GameNotFoundError);
    expect(checkGame).not.toHaveBeenCalled();
  });

  it('refuses a wager over the players own limit before touching the provider', async () => {
    const created = await seedGame({ name: 'Limited' });
    const launchGame = vi.fn();
    const walletCommands = makeWalletCommands({
      ok: true,
      moved: false,
      newBalance: '0',
      currency: 'USD',
    });
    const svc = makeService({
      provider: mock<GameAdapter>({ launchGame, endRound: vi.fn() }),
      walletCommands,
      rgLimits: refusingLimits(),
    });

    await expect(startRound(svc, 'user-1', created.id, 'EUR', '10')).rejects.toMatchObject({
      name: 'RgLimitExceededError',
      data: { reason: 'wager_limit_exceeded', limitType: 'wager', limit: '50', used: '45' },
    });
    expect(launchGame).not.toHaveBeenCalled();
    expect(walletCommands.debit).not.toHaveBeenCalled();
  });

  it('starts a round when no limit gate is bound at all', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000c1', name: 'Ungated' });
    const svc = makeService();

    await expect(
      startRound(svc, '00000000-0000-0000-0000-000000000111', created.id, 'USD', '10'),
    ).resolves.toMatchObject({ launchUrl: 'https://mock/play' });
  });

  it('refuses a restricted player before touching the provider', async () => {
    const created = await seedGame({ name: 'Restricted' });
    const launchGame = vi.fn();
    const svc = makeService({
      provider: mock<GameAdapter>({ launchGame, endRound: vi.fn() }),
      playEligibility: eligibility(true),
    });

    await expect(startRound(svc, 'user-1', created.id, 'EUR', '10')).rejects.toBeInstanceOf(
      RgRestrictedError,
    );
    expect(launchGame).not.toHaveBeenCalled();
  });

  it('passes the gate for an unrestricted player and fails later on the game lookup', async () => {
    const launchGame = vi.fn();
    const svc = makeService({
      provider: mock<GameAdapter>({ launchGame, endRound: vi.fn() }),
    });

    await expect(
      startRound(
        svc,
        '00000000-0000-0000-0000-000000000111',
        '00000000-0000-0000-0000-000000000222',
        'EUR',
        '10',
      ),
    ).rejects.toBeInstanceOf(GameNotFoundError);
    expect(launchGame).not.toHaveBeenCalled();
  });

  it('404s an inactive game without touching the wallet or provider', async () => {
    const created = await seedGame({ name: 'Dark', isActive: false });
    const walletCommands = makeWalletCommands({
      ok: true,
      moved: false,
      newBalance: '90',
      currency: 'USD',
    });
    const launchGame = vi.fn();
    const svc = makeService({
      provider: mock<GameAdapter>({ launchGame, endRound: vi.fn() }),
      walletCommands,
    });

    await expect(
      svc.startRound('00000000-0000-0000-0000-000000000311', created.id, 'USD', '10'),
    ).rejects.toBeInstanceOf(GameNotFoundError);
    expect(walletCommands.debit).not.toHaveBeenCalled();
    expect(launchGame).not.toHaveBeenCalled();
    expect(await db.drizzle.db.select().from(gameRound)).toHaveLength(0);
  });

  it('404s a vendor-unavailable game without touching the wallet or provider', async () => {
    const created = await seedGame({ name: 'Down', isUnavailable: true });
    const walletCommands = makeWalletCommands({
      ok: true,
      moved: false,
      newBalance: '90',
      currency: 'USD',
    });
    const launchGame = vi.fn();
    const svc = makeService({
      provider: mock<GameAdapter>({ launchGame, endRound: vi.fn() }),
      walletCommands,
    });

    await expect(
      svc.startRound('00000000-0000-0000-0000-000000000313', created.id, 'USD', '10'),
    ).rejects.toBeInstanceOf(GameNotFoundError);
    expect(walletCommands.debit).not.toHaveBeenCalled();
    expect(launchGame).not.toHaveBeenCalled();
    expect(await db.drizzle.db.select().from(gameRound)).toHaveLength(0);
  });

  it('404s a game on a deactivated provider without touching the wallet or provider', async () => {
    const created = await seedGame({ name: 'Orphaned' });
    await db.drizzle.db
      .update(gameProvider)
      .set({ isActive: false })
      .where(eq(gameProvider.id, created.providerId));
    const walletCommands = makeWalletCommands({
      ok: true,
      moved: false,
      newBalance: '90',
      currency: 'USD',
    });
    const launchGame = vi.fn();
    const svc = makeService({
      provider: mock<GameAdapter>({ launchGame, endRound: vi.fn() }),
      walletCommands,
    });

    await expect(
      svc.startRound('00000000-0000-0000-0000-000000000312', created.id, 'USD', '10'),
    ).rejects.toBeInstanceOf(GameNotFoundError);
    expect(walletCommands.debit).not.toHaveBeenCalled();
    expect(launchGame).not.toHaveBeenCalled();
    expect(await db.drizzle.db.select().from(gameRound)).toHaveLength(0);
  });

  it('debits the stake and persists the round on sufficient balance', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000a1', name: 'Aces' });
    const walletCommands = makeWalletCommands({
      ok: true,
      moved: false,
      newBalance: '90',
      currency: 'USD',
    });
    const launchGame = vi.fn().mockResolvedValue({ launchUrl: 'https://mock/play', token: 'tok' });
    const svc = makeService({
      provider: mock<GameAdapter>({ launchGame, endRound: vi.fn() }),
      walletCommands,
    });

    const userId = '00000000-0000-0000-0000-000000000301';
    const result = await startRound(svc, userId, created.id, 'USD', '10');

    expect(walletCommands.debit).toHaveBeenCalledWith(expect.anything(), {
      userId,
      amount: '10',
      currency: 'USD',
      type: 'bet',
    });
    expect(launchGame).toHaveBeenCalledWith(created.id, userId, 'USD');
    expect(result).toEqual({
      roundId: expect.any(String),
      launchUrl: 'https://mock/play',
      token: 'tok',
    });

    const rounds = await db.drizzle.db.select().from(gameRound);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ gameId: created.id, userId, currency: 'USD' });
    expect(Number(rounds[0]?.betAmount)).toBe(10);
  });

  it('throws InsufficientBalanceError, persists no round, and never launches the game when the debit fails', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000a2', name: 'Aces' });
    const walletCommands = makeWalletCommands({ ok: false, available: '2' });
    const launchGame = vi.fn();
    const svc = makeService({
      provider: mock<GameAdapter>({ launchGame, endRound: vi.fn() }),
      walletCommands,
    });

    await expect(
      startRound(svc, '00000000-0000-0000-0000-000000000302', created.id, 'USD', '10'),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(launchGame).not.toHaveBeenCalled();
    expect(await db.drizzle.db.select().from(gameRound)).toHaveLength(0);
  });
});

describe('GamingService listGames provider gate (real PG)', () => {
  it('separates the public playable gate from the admin game-active filter', async () => {
    const live = await seedGame({ name: 'Live Game' });
    const hidden = await seedGame({ name: 'Hidden Game' });
    await db.drizzle.db
      .update(gameProvider)
      .set({ isActive: false })
      .where(eq(gameProvider.id, hidden.providerId));
    const svc = makeService();

    const pub = await svc.listGamesPublic({ page: 1, limit: 10 });
    expect(pub.items.map((g) => g.id)).toEqual([live.id]);
    expect(pub.total).toBe(1);

    const admin = await svc.listGamesAdmin({ page: 1, limit: 10, isActive: true });
    expect(admin.total).toBe(2);
  });

  it('listGamesAdmin includes non-playable games and sorts by provider and game fields', async () => {
    const alphaZulu = await seedProvider({ name: 'Alpha', slug: 'zulu' });
    const alphaAlpha = await seedProvider({ name: 'Alpha', slug: 'alpha' });
    const betaAlpha = await seedProvider({ name: 'Beta', slug: 'beta-alpha', isActive: false });
    await seedGame({
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Same',
      providerId: alphaZulu.id,
    });
    await seedGame({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Same',
      providerId: alphaZulu.id,
    });
    await seedGame({ name: 'Zulu', providerId: alphaAlpha.id });
    await seedGame({ name: 'Aardvark', providerId: betaAlpha.id });

    const result = await makeService().listGamesAdmin({ page: 1, limit: 10 });

    expect(
      result.items.map((item) => [item.provider.name, item.provider.slug, item.name, item.id]),
    ).toEqual([
      ['Alpha', 'alpha', 'Zulu', expect.any(String)],
      ['Alpha', 'zulu', 'Same', '00000000-0000-4000-8000-000000000001'],
      ['Alpha', 'zulu', 'Same', '00000000-0000-4000-8000-000000000002'],
      ['Beta', 'beta-alpha', 'Aardvark', expect.any(String)],
    ]);
    expect(result.total).toBe(4);
  });
});

describe('GamingService admin list filters (real PG)', () => {
  const ids = (page: { items: { id: string }[] }) => page.items.map((g) => g.id).sort();

  async function tagGame(gameId: string, tagIds: string[]) {
    await db.drizzle.db.insert(gameTagGame).values(tagIds.map((tagId) => ({ gameId, tagId })));
  }

  async function blockGame(gameId: string, countryCodes: string[]) {
    await db.drizzle.db
      .insert(gameGeoRule)
      .values(countryCodes.map((countryCode) => ({ gameId, countryCode, reason: 'licence' })));
  }

  it('categoryIds keeps only games in every listed category', async () => {
    const slots = await seedCategory();
    const jackpot = await seedCategory();
    const both = await seedGame({}, [slots.id, jackpot.id]);
    await seedGame({}, [slots.id]);
    await seedGame({}, [jackpot.id]);

    const result = await makeService().listGamesAdmin({
      page: 1,
      limit: 10,
      categoryIds: [slots.id, jackpot.id],
    });

    expect(ids(result)).toEqual([both.id]);
    expect(result.total).toBe(1);
  });

  it('uncategorized splits games with no category from games with one', async () => {
    const bare = await seedGame({}, []);
    const filed = await seedGame();
    const svc = makeService();

    expect(ids(await svc.listGamesAdmin({ page: 1, limit: 10, uncategorized: true }))).toEqual([
      bare.id,
    ]);
    expect(ids(await svc.listGamesAdmin({ page: 1, limit: 10, uncategorized: false }))).toEqual([
      filed.id,
    ]);
  });

  it('tagIds keeps only games carrying every listed tag', async () => {
    const hot = await seedTag();
    const fresh = await seedTag();
    const both = await seedGame();
    const onlyHot = await seedGame();
    await tagGame(both.id, [hot.id, fresh.id]);
    await tagGame(onlyHot.id, [hot.id]);
    const svc = makeService();

    expect(
      ids(await svc.listGamesAdmin({ page: 1, limit: 10, tagIds: [hot.id, fresh.id] })),
    ).toEqual([both.id]);
    expect(ids(await svc.listGamesAdmin({ page: 1, limit: 10, tagIds: [hot.id] }))).toEqual(
      [both.id, onlyHot.id].sort(),
    );
  });

  it('gameTypes matches any listed type', async () => {
    const original = await seedGame({ gameType: 'original' });
    const casino = await seedGame({ gameType: 'casino' });
    await seedGame({ gameType: 'sportsbook' });

    const result = await makeService().listGamesAdmin({
      page: 1,
      limit: 10,
      gameTypes: ['original', 'casino'],
    });

    expect(ids(result)).toEqual([original.id, casino.id].sort());
  });

  it('geoBlocked and geoBlockedCountries filter on per-game geo rules', async () => {
    const deFr = await seedGame();
    const de = await seedGame();
    const open = await seedGame();
    await blockGame(deFr.id, ['DE', 'FR']);
    await blockGame(de.id, ['DE']);
    const svc = makeService({ gameGeoCheck: mock<GameGeoCheckPort>({}) });

    expect(ids(await svc.listGamesAdmin({ page: 1, limit: 10, geoBlocked: true }))).toEqual(
      [deFr.id, de.id].sort(),
    );
    expect(ids(await svc.listGamesAdmin({ page: 1, limit: 10, geoBlocked: false }))).toEqual([
      open.id,
    ]);
    expect(
      ids(await svc.listGamesAdmin({ page: 1, limit: 10, geoBlockedCountries: ['DE', 'FR'] })),
    ).toEqual([deFr.id]);
  });

  it('counts a provider geo rule as blocking every game of that provider', async () => {
    const blockedStudio = await seedProvider();
    const viaProvider = await seedGame({ providerId: blockedStudio.id });
    const viaBoth = await seedGame({ providerId: blockedStudio.id });
    const viaGame = await seedGame();
    const open = await seedGame();
    await db.drizzle.db
      .insert(providerGeoRule)
      .values({ providerId: blockedStudio.id, countryCode: 'DE', reason: 'licence' });
    await blockGame(viaBoth.id, ['DE', 'FR']);
    await blockGame(viaGame.id, ['FR']);
    const svc = makeService({ gameGeoCheck: mock<GameGeoCheckPort>({}) });

    expect(ids(await svc.listGamesAdmin({ page: 1, limit: 10, geoBlocked: true }))).toEqual(
      [viaProvider.id, viaBoth.id, viaGame.id].sort(),
    );
    expect(ids(await svc.listGamesAdmin({ page: 1, limit: 10, geoBlocked: false }))).toEqual([
      open.id,
    ]);
    expect(
      ids(await svc.listGamesAdmin({ page: 1, limit: 10, geoBlockedCountries: ['DE'] })),
    ).toEqual([viaProvider.id, viaBoth.id].sort());
    expect(
      ids(await svc.listGamesAdmin({ page: 1, limit: 10, geoBlockedCountries: ['DE', 'FR'] })),
    ).toEqual([viaBoth.id]);
  });

  it('refuses the geo filters when no geo check is bound', async () => {
    const svc = makeService();

    await expect(
      svc.listGamesAdmin({ page: 1, limit: 10, geoBlocked: true }),
    ).rejects.toBeInstanceOf(GameGeoFiltersUnavailableError);
    await expect(
      svc.listGamesAdmin({ page: 1, limit: 10, geoBlockedCountries: ['DE'] }),
    ).rejects.toBeInstanceOf(GameGeoFiltersUnavailableError);
    await expect(svc.listGamesAdmin({ page: 1, limit: 10 })).resolves.toMatchObject({ total: 0 });
  });

  it('combines filters with AND', async () => {
    const hot = await seedTag();
    const match = await seedGame({ gameType: 'original', isActive: true });
    const inactive = await seedGame({ gameType: 'original', isActive: false });
    const otherType = await seedGame({ gameType: 'casino', isActive: true });
    await tagGame(match.id, [hot.id]);
    await tagGame(inactive.id, [hot.id]);
    await tagGame(otherType.id, [hot.id]);

    const result = await makeService().listGamesAdmin({
      page: 1,
      limit: 10,
      isActive: true,
      tagIds: [hot.id],
      gameTypes: ['original'],
    });

    expect(ids(result)).toEqual([match.id]);
  });
});

describe('ListAdminGamesInputSchema', () => {
  const id = '00000000-0000-4000-8000-000000000001';

  it('wraps a single query value into a list and drops duplicates', () => {
    const parsed = ListAdminGamesInputSchema.parse({
      tagIds: id,
      categoryIds: [id, id],
      gameTypes: 'casino',
    });
    expect(parsed).toMatchObject({ tagIds: [id], categoryIds: [id], gameTypes: ['casino'] });
  });

  it('applies the list cap after dropping duplicates', () => {
    expect(
      ListAdminGamesInputSchema.safeParse({
        gameTypes: ['casino', 'casino', 'original', 'sportsbook'],
      }).success,
    ).toBe(true);
    expect(
      ListAdminGamesInputSchema.safeParse({
        tagIds: Array.from({ length: 51 }, () => randomUUID()),
      }).success,
    ).toBe(false);
  });

  it('rejects uncategorized combined with a category filter', () => {
    expect(
      ListAdminGamesInputSchema.safeParse({ uncategorized: 'true', categoryIds: [id] }).success,
    ).toBe(false);
    expect(
      ListAdminGamesInputSchema.safeParse({ uncategorized: 'true', categoryId: id }).success,
    ).toBe(false);
    expect(
      ListAdminGamesInputSchema.safeParse({ uncategorized: 'false', categoryIds: [id] }).success,
    ).toBe(true);
  });

  it('rejects geoBlocked=false combined with geoBlockedCountries', () => {
    expect(
      ListAdminGamesInputSchema.safeParse({ geoBlocked: 'false', geoBlockedCountries: ['DE'] })
        .success,
    ).toBe(false);
    expect(
      ListAdminGamesInputSchema.safeParse({ geoBlocked: 'true', geoBlockedCountries: ['DE'] })
        .success,
    ).toBe(true);
  });

  it('rejects a lowercase country code', () => {
    expect(ListAdminGamesInputSchema.safeParse({ geoBlockedCountries: ['de'] }).success).toBe(
      false,
    );
  });
});

describe('GamingService unavailable games (real PG)', () => {
  it('hides a vendor-unavailable game publicly while the admin list can filter on it', async () => {
    const live = await seedGame({ name: 'Live' });
    const down = await seedGame({ name: 'Down', isUnavailable: true });
    const svc = makeService();

    const pub = await svc.listGamesPublic({ page: 1, limit: 10 });
    expect(pub.items.map((g) => g.id)).toEqual([live.id]);
    await expect(svc.getGame(down.id, { activeOnly: true })).rejects.toBeInstanceOf(
      GameNotFoundError,
    );

    const unavailable = await svc.listGamesAdmin({ page: 1, limit: 10, isUnavailable: true });
    expect(unavailable.items).toEqual([
      expect.objectContaining({ id: down.id, isActive: true, isUnavailable: true }),
    ]);
    const available = await svc.listGamesAdmin({ page: 1, limit: 10, isUnavailable: false });
    expect(available.items.map((g) => g.id)).toEqual([live.id]);
  });

  it('flips availability, audits each real change once, and keeps the admin isActive choice', async () => {
    const created = await seedGame({ isActive: false });
    const events = makeEventBus();
    const svc = makeService({ events });

    await expect(
      svc.setGameAvailability({ gameId: created.id, isUnavailable: true }),
    ).resolves.toEqual({ changed: true });
    await expect(
      svc.setGameAvailability({ gameId: created.id, isUnavailable: true }),
    ).resolves.toEqual({ changed: false });
    await expect(svc.getGame(created.id)).resolves.toMatchObject({
      isActive: false,
      isUnavailable: true,
    });

    await svc.setGameAvailability({ gameId: created.id, isUnavailable: false });
    await expect(svc.getGame(created.id)).resolves.toMatchObject({
      isActive: false,
      isUnavailable: false,
    });

    expect(
      events.emit.mock.calls.filter(([topic]) => topic === 'gaming.game.availability_changed'),
    ).toEqual([
      [
        'gaming.game.availability_changed',
        { gameId: created.id, before: { isUnavailable: false }, after: { isUnavailable: true } },
      ],
      [
        'gaming.game.availability_changed',
        { gameId: created.id, before: { isUnavailable: true }, after: { isUnavailable: false } },
      ],
    ]);
  });

  it('refuses an unknown game', async () => {
    await expect(
      makeService().setGameAvailability({ gameId: randomUUID(), isUnavailable: true }),
    ).rejects.toBeInstanceOf(GameNotFoundError);
  });

  it('marks every category containing the game dirty for a rank sweep on a real flip', async () => {
    const category = await seedCategory();
    const created = await seedGame({}, [category.id]);
    const svc = makeService();

    const before = await db.drizzle.db
      .select({ rankDirtyAt: gameCategory.rankDirtyAt })
      .from(gameCategory)
      .where(eq(gameCategory.id, category.id));
    expect(before[0]?.rankDirtyAt).toBeNull();

    await svc.setGameAvailability({ gameId: created.id, isUnavailable: true });

    const after = await db.drizzle.db
      .select({ rankDirtyAt: gameCategory.rankDirtyAt })
      .from(gameCategory)
      .where(eq(gameCategory.id, category.id));
    expect(after[0]?.rankDirtyAt).not.toBeNull();
  });
});

describe('GamingService.startRound bonus rollover completion (real PG)', () => {
  it('emits wallet.bonus_rollover.completed once per credit the bet just completed', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000a3', name: 'Aces' });
    const events = makeEventBus();
    const walletCommands = makeWalletCommands({
      ok: true,
      moved: true,
      transactionId: '00000000-0000-0000-0000-0000000000d3',
      newBalance: '60',
      currency: 'USD',
      completedBonusCredits: [
        { id: '00000000-0000-0000-0000-0000000000c1', currency: 'USD', creditedAmount: '25' },
        { id: '00000000-0000-0000-0000-0000000000c2', currency: 'USD', creditedAmount: '10' },
      ],
    });
    const svc = new GamingService(
      db.drizzle,
      events,
      mock<GameAdapter>({
        launchGame: vi.fn().mockResolvedValue({ launchUrl: 'https://mock/play', token: 'tok' }),
        endRound: vi.fn(),
      }),
      unrestricted,
      walletCommands,
      makeIdentityReader(),
    );
    const userId = '00000000-0000-0000-0000-000000000401';

    await startRound(svc, userId, created.id, 'USD', '40');

    expect(events.emit).toHaveBeenCalledWith('wallet.bonus_rollover.completed', {
      userId,
      creditId: '00000000-0000-0000-0000-0000000000c1',
      currency: 'USD',
      creditedAmount: '25',
    });
    expect(events.emit).toHaveBeenCalledWith('wallet.bonus_rollover.completed', {
      userId,
      creditId: '00000000-0000-0000-0000-0000000000c2',
      currency: 'USD',
      creditedAmount: '10',
    });
  });

  it('emits rollover completion before a provider launch failure can discard the notification', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000a5', name: 'Aces' });
    const events = makeEventBus();
    const launchGame = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    const walletCommands = makeWalletCommands({
      ok: true,
      moved: true,
      transactionId: '00000000-0000-0000-0000-0000000000d4',
      newBalance: '0',
      currency: 'USD',
      completedBonusCredits: [
        { id: '00000000-0000-0000-0000-0000000000c5', currency: 'USD', creditedAmount: '25' },
      ],
    });
    const svc = new GamingService(
      db.drizzle,
      events,
      mock<GameAdapter>({ launchGame, endRound: vi.fn() }),
      unrestricted,
      walletCommands,
      makeIdentityReader(),
    );
    const userId = '00000000-0000-0000-0000-000000000405';

    await expect(startRound(svc, userId, created.id, 'USD', '25')).rejects.toThrow(
      'provider unavailable',
    );

    expect(events.emit).toHaveBeenCalledWith('wallet.bonus_rollover.completed', {
      userId,
      creditId: '00000000-0000-0000-0000-0000000000c5',
      currency: 'USD',
      creditedAmount: '25',
    });
    expect(launchGame).toHaveBeenCalledOnce();
  });

  it('emits no wallet.bonus_rollover.completed event when the debit completed no credit', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000a4', name: 'Aces' });
    const events = makeEventBus();
    const walletCommands = makeWalletCommands({
      ok: true,
      moved: false,
      newBalance: '90',
      currency: 'USD',
    });
    const svc = new GamingService(
      db.drizzle,
      events,
      mock<GameAdapter>({
        launchGame: vi.fn().mockResolvedValue({ launchUrl: 'https://mock/play', token: 'tok' }),
        endRound: vi.fn(),
      }),
      unrestricted,
      walletCommands,
      makeIdentityReader(),
    );
    const userId = '00000000-0000-0000-0000-000000000402';

    await startRound(svc, userId, created.id, 'USD', '10');

    expect(events.emit).not.toHaveBeenCalledWith(
      'wallet.bonus_rollover.completed',
      expect.anything(),
    );
  });
});

describe('GamingService.startRound wallet.balance.changed event (real PG)', () => {
  it('emits it, after the round is persisted, for the bet debit', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000a6', name: 'Aces' });
    const events = makeEventBus();
    const walletCommands = makeWalletCommands({
      ok: true,
      moved: true,
      newBalance: '90',
      currency: 'USD',
      transactionId: '00000000-0000-0000-0000-0000000000d1',
    });
    const svc = new GamingService(
      db.drizzle,
      events,
      mock<GameAdapter>({
        launchGame: vi.fn().mockResolvedValue({ launchUrl: 'https://mock/play', token: 'tok' }),
        endRound: vi.fn(),
      }),
      unrestricted,
      walletCommands,
      makeIdentityReader(),
    );
    const userId = '00000000-0000-0000-0000-000000000406';

    await startRound(svc, userId, created.id, 'USD', '10');

    expect(events.emit).toHaveBeenCalledWith('wallet.balance.changed', {
      userId,
      playerId: null,
      amount: '10',
      currency: 'USD',
      transactionId: '00000000-0000-0000-0000-0000000000d1',
      type: 'bet',
      direction: 'debit',
    });
  });

  it('never emits it when the debit outcome reports nothing moved', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000a7', name: 'Aces' });
    const events = makeEventBus();
    // The real WalletCommandsService only reports `moved: false` for a no-op move (loss,
    // replay) - gaming never debits either, but the caller must still honor the
    // contract rather than assume every success moved money.
    const walletCommands = makeWalletCommands({
      ok: true,
      moved: false,
      newBalance: '90',
      currency: 'USD',
    });
    const svc = new GamingService(
      db.drizzle,
      events,
      mock<GameAdapter>({
        launchGame: vi.fn().mockResolvedValue({ launchUrl: 'https://mock/play', token: 'tok' }),
        endRound: vi.fn(),
      }),
      unrestricted,
      walletCommands,
      makeIdentityReader(),
    );
    const userId = '00000000-0000-0000-0000-000000000407';

    await startRound(svc, userId, created.id, 'USD', '10');

    expect(events.emit).not.toHaveBeenCalledWith('wallet.balance.changed', expect.anything());
  });
});

describe('GamingService updateGame (real PG)', () => {
  const emittedTopics = (events: ReturnType<typeof makeEventBus>) =>
    events.emit.mock.calls.map(([topic]) => topic);

  it('patches scalar fields and emits an event', async () => {
    const created = await seedGame({ name: 'Roulette' });
    const events = makeEventBus();
    const svc = makeService({ events });

    const updated = await svc.updateGame({
      id: created.id,
      name: 'Roulette Gold',
      isActive: false,
      ...ACTOR,
    });

    expect(updated).toMatchObject({ name: 'Roulette Gold', isActive: false });
    expect(emittedTopics(events)).toContain('gaming.game.updated');
  });

  it('replaces the category set, including clearing it with an empty array', async () => {
    const table = await seedCategory({ slug: 'table-games', name: 'Table Games' });
    const blackjack = await seedCategory({ slug: 'blackjack', name: 'Blackjack' });
    const created = await seedGame({}, [table.id, blackjack.id]);
    const svc = makeService();

    const replaced = await svc.updateGame({
      id: created.id,
      categoryIds: [blackjack.id],
      ...ACTOR,
    });
    expect(replaced.categories.map((c) => c.slug)).toEqual(['blackjack']);

    const cleared = await svc.updateGame({ id: created.id, categoryIds: [], ...ACTOR });
    expect(cleared.categories).toEqual([]);
  });

  it('keeps the position and pin of a category link the new set keeps', async () => {
    const table = await seedCategory({ slug: 'table-games', name: 'Table Games' });
    const blackjack = await seedCategory({ slug: 'blackjack', name: 'Blackjack' });
    const created = await seedGame({}, [table.id]);
    await db.drizzle.db
      .update(gameCategoryGame)
      .set({ position: 3, pinnedPosition: 0 })
      .where(eq(gameCategoryGame.gameId, created.id));

    await makeService().updateGame({
      id: created.id,
      categoryIds: [table.id, blackjack.id],
      ...ACTOR,
    });

    const [kept] = await db.drizzle.db
      .select({
        position: gameCategoryGame.position,
        pinnedPosition: gameCategoryGame.pinnedPosition,
      })
      .from(gameCategoryGame)
      .where(
        and(eq(gameCategoryGame.gameId, created.id), eq(gameCategoryGame.categoryId, table.id)),
      );
    expect(kept).toEqual({ position: 3, pinnedPosition: 0 });
  });

  it('replaces the tag set, including invisible tags for admin results', async () => {
    const visible = await seedTag({ name: 'Visible', visibility: 'visible' });
    const invisible = await seedTag({ name: 'Invisible', visibility: 'invisible' });
    const created = await seedGame();
    const svc = makeService();

    const replaced = await svc.updateGame({
      id: created.id,
      tagIds: [visible.id, invisible.id],
      ...ACTOR,
    });
    expect(replaced.tags.map((tag) => tag.name)).toEqual(['Invisible', 'Visible']);
    expect((await svc.getGame(created.id)).tags.map((tag) => tag.name)).toEqual(['Visible']);

    const cleared = await svc.updateGame({ id: created.id, tagIds: [], ...ACTOR });
    expect(cleared.tags).toEqual([]);
  });

  it('serializes against a concurrent tag delete instead of racing an FK violation', async () => {
    const tag = await seedTag({ name: 'Raced', type: 'custom' });
    const created = await seedGame();
    const svc = makeService();

    let updateGamePromise!: Promise<unknown>;
    await db.drizzle.db.transaction(async (tx) => {
      await tx.select({ id: gameTag.id }).from(gameTag).where(eq(gameTag.id, tag.id)).for('update');

      updateGamePromise = svc.updateGame({ id: created.id, tagIds: [tag.id], ...ACTOR });

      await tx.delete(gameTag).where(eq(gameTag.id, tag.id));
    });

    await expect(updateGamePromise).rejects.toBeInstanceOf(GameTagNotFoundError);
  });

  it('leaves links untouched when categoryIds is omitted', async () => {
    const table = await seedCategory({ slug: 'table-games', name: 'Table Games' });
    const created = await seedGame({}, [table.id]);
    const svc = makeService();

    const updated = await svc.updateGame({ id: created.id, name: 'Renamed', ...ACTOR });
    expect(updated.categories.map((c) => c.slug)).toEqual(['table-games']);
  });

  it('reassigns the provider and validates all references', async () => {
    const created = await seedGame();
    const other = await seedProvider({ slug: 'other-studio', name: 'Other' });
    const svc = makeService();

    const updated = await svc.updateGame({
      id: created.id,
      providerId: other.id,
      ...ACTOR,
    });
    expect(updated.provider).toMatchObject({ slug: 'other-studio' });

    await expect(
      svc.updateGame({
        id: created.id,
        providerId: '00000000-0000-4000-8000-000000000000',
        ...ACTOR,
      }),
    ).rejects.toBeInstanceOf(GameProviderNotFoundError);
    await expect(
      svc.updateGame({
        id: created.id,
        categoryIds: ['00000000-0000-4000-8000-000000000000'],
        ...ACTOR,
      }),
    ).rejects.toBeInstanceOf(GameCategoryNotFoundError);
    await expect(
      svc.updateGame({
        id: created.id,
        tagIds: ['00000000-0000-4000-8000-000000000000'],
        ...ACTOR,
      }),
    ).rejects.toBeInstanceOf(GameTagNotFoundError);
    await expect(
      svc.updateGame({
        id: '00000000-0000-4000-8000-000000000000',
        name: 'X',
        ...ACTOR,
      }),
    ).rejects.toBeInstanceOf(GameNotFoundError);
  });

  it('rejects an aggregator the target provider is not mapped on', async () => {
    const created = await seedGame();
    const unmapped = await seedProvider({ slug: 'unmapped-studio', name: 'Unmapped' });
    await db.drizzle.db
      .delete(gameProviderAggregatorMapping)
      .where(eq(gameProviderAggregatorMapping.providerId, unmapped.id));
    const svc = makeService();

    await expect(
      svc.updateGame({ id: created.id, providerId: unmapped.id, ...ACTOR }),
    ).rejects.toBeInstanceOf(GameAggregatorNotMappedError);

    await expect(
      svc.updateGame({ id: created.id, aggregator: 'everymatrix', ...ACTOR }),
    ).rejects.toBeInstanceOf(GameAggregatorNotMappedError);

    await db.drizzle.db
      .insert(gameProviderAggregatorMapping)
      .values({ providerId: unmapped.id, aggregator: 'everymatrix', vendorId: 'vendor-unmapped' });
    const moved = await svc.updateGame({
      id: created.id,
      providerId: unmapped.id,
      aggregator: 'everymatrix',
      ...ACTOR,
    });
    expect(moved).toMatchObject({
      provider: { slug: 'unmapped-studio' },
      aggregator: 'everymatrix',
    });
  });

  it('rejects a taken game slug', async () => {
    const created = await seedGame({ slug: 'game-one' });
    await seedGame({ slug: 'game-two' });
    const svc = makeService();

    await expect(
      svc.updateGame({ id: created.id, slug: 'game-two', ...ACTOR }),
    ).rejects.toBeInstanceOf(GameSlugTakenError);
  });
});

async function seedRound(gameId: string, userId: string) {
  const [row] = await db.drizzle.db
    .insert(gameRound)
    .values({ gameId, userId, currency: 'USD', betAmount: '10', status: 'active' })
    .returning();
  return row!;
}

const settlingProvider = (winAmount?: string) =>
  mock<GameAdapter>({
    launchGame: vi.fn(),
    endRound: vi.fn().mockResolvedValue(winAmount === undefined ? undefined : { winAmount }),
  });

describe('GamingService.endRound (real PG)', () => {
  const userId = '00000000-0000-0000-0000-000000000501';

  it('settles an admitted active round without rechecking a newly blocking geo policy', async () => {
    const created = await seedGame();
    const round = await seedRound(created.id, userId);
    const checkGame = vi.fn().mockResolvedValue({
      allowed: false,
      countryCode: 'US',
      reason: 'game_block',
    });
    const svc = makeService({
      provider: settlingProvider('5'),
      gameGeoCheck: mock<GameGeoCheckPort>({ checkGame }),
    });

    await expect(svc.endRound(userId, round.id)).resolves.toEqual({
      success: true,
      winAmount: '5',
    });
    expect(checkGame).not.toHaveBeenCalled();
  });

  it('credits the provider-reported win to the round currency and records it on the round', async () => {
    const created = await seedGame();
    const round = await seedRound(created.id, userId);
    const walletCommands = makeWalletCommands({
      ok: true,
      moved: false,
      newBalance: '0',
      currency: 'USD',
    });
    const svc = makeService({ provider: settlingProvider('42.50'), walletCommands });

    expect(await svc.endRound(userId, round.id)).toEqual({ success: true, winAmount: '42.50' });

    expect(walletCommands.credit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId, amount: '42.50', currency: 'USD', type: 'win' }),
    );
    const [settled] = await db.drizzle.db.select().from(gameRound);
    expect(settled?.status).toBe('completed');
    expect(Number(settled?.winAmount)).toBe(42.5);
  });

  it('credits nothing when the provider reports no outcome', async () => {
    const created = await seedGame();
    const round = await seedRound(created.id, userId);
    const walletCommands = makeWalletCommands({
      ok: true,
      moved: false,
      newBalance: '0',
      currency: 'USD',
    });
    const svc = makeService({ provider: settlingProvider(), walletCommands });

    expect(await svc.endRound(userId, round.id)).toEqual({ success: true, winAmount: '0' });

    expect(walletCommands.credit).not.toHaveBeenCalled();
  });

  it('pays a win once - a replayed end never asks the provider or credits again', async () => {
    const created = await seedGame();
    const round = await seedRound(created.id, userId);
    const walletCommands = makeWalletCommands({
      ok: true,
      moved: false,
      newBalance: '0',
      currency: 'USD',
    });
    const provider = settlingProvider('7');
    const svc = makeService({ provider, walletCommands });

    await svc.endRound(userId, round.id);
    const replayed = await svc.endRound(userId, round.id);
    expect(replayed.success).toBe(true);
    expect(Number(replayed.winAmount)).toBe(7);

    expect(provider.endRound).toHaveBeenCalledOnce();
    expect(walletCommands.credit).toHaveBeenCalledOnce();
  });

  it('leaves the round open when the win credit is refused, so the payout is not lost', async () => {
    const created = await seedGame();
    const round = await seedRound(created.id, userId);
    const walletCommands = makeWalletCommands(
      { ok: true, moved: false, newBalance: '0', currency: 'USD' },
      { ok: false, reason: 'wallet not found' },
    );
    const svc = makeService({ provider: settlingProvider('7'), walletCommands });

    await expect(svc.endRound(userId, round.id)).rejects.toBeInstanceOf(WinCreditFailedError);

    const [unsettled] = await db.drizzle.db.select().from(gameRound);
    expect(unsettled?.status).toBe('active');
    expect(Number(unsettled?.winAmount)).toBe(0);
  });
});

describe('GamingService.endRound wallet.balance.changed event (real PG)', () => {
  const userId = '00000000-0000-0000-0000-000000000502';

  it('emits it, after the round is settled, for the win credit', async () => {
    const created = await seedGame();
    const round = await seedRound(created.id, userId);
    const events = makeEventBus();
    const walletCommands = makeWalletCommands(
      { ok: true, moved: false, newBalance: '0', currency: 'USD' },
      {
        ok: true,
        moved: true,
        newBalance: '42.50',
        transactionId: '00000000-0000-0000-0000-0000000000e1',
      },
    );
    const svc = new GamingService(
      db.drizzle,
      events,
      settlingProvider('42.50'),
      unrestricted,
      walletCommands,
      makeIdentityReader(),
    );

    await svc.endRound(userId, round.id);

    expect(events.emit).toHaveBeenCalledWith('wallet.balance.changed', {
      userId,
      playerId: null,
      amount: '42.50',
      currency: 'USD',
      transactionId: '00000000-0000-0000-0000-0000000000e1',
      type: 'win',
      direction: 'credit',
    });
  });

  it('never emits it when the provider reports no win', async () => {
    const created = await seedGame();
    const round = await seedRound(created.id, userId);
    const events = makeEventBus();
    const walletCommands = makeWalletCommands({
      ok: true,
      moved: false,
      newBalance: '0',
      currency: 'USD',
    });
    const svc = new GamingService(
      db.drizzle,
      events,
      settlingProvider(),
      unrestricted,
      walletCommands,
      makeIdentityReader(),
    );

    await svc.endRound(userId, round.id);

    expect(walletCommands.credit).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalledWith('wallet.balance.changed', expect.anything());
  });

  it('never emits it when the credit outcome reports nothing moved', async () => {
    const created = await seedGame();
    const round = await seedRound(created.id, userId);
    const events = makeEventBus();
    const walletCommands = makeWalletCommands(
      { ok: true, moved: false, newBalance: '0', currency: 'USD' },
      { ok: true, moved: false, newBalance: '42.50' },
    );
    const svc = new GamingService(
      db.drizzle,
      events,
      settlingProvider('42.50'),
      unrestricted,
      walletCommands,
      makeIdentityReader(),
    );

    await svc.endRound(userId, round.id);

    expect(events.emit).not.toHaveBeenCalledWith('wallet.balance.changed', expect.anything());
  });
});

describe('GamingService.accumulateExternalRound (real PG)', () => {
  it('creates a game_round row on the first call for a given externalRoundId', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000b1', name: 'Aces' });
    const svc = makeService();
    const userId = '00000000-0000-0000-0000-000000000501';

    const result = await svc.accumulateExternalRound(db.drizzle.db, {
      gameId: created.id,
      userId,
      currency: 'USD',
      externalRoundId: 'ext-round-1',
      betDelta: '10',
      winDelta: '0',
    });

    expect(Number(result.betAmount)).toBe(10);
    expect(Number(result.winAmount)).toBe(0);
    const rows = await db.drizzle.db.select().from(gameRound);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.roundId,
      gameId: created.id,
      userId,
      currency: 'USD',
      externalRoundId: 'ext-round-1',
      status: 'active',
    });
  });

  it('accumulates betAmount/winAmount on every subsequent call for the same externalRoundId', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000b2', name: 'Aces' });
    const svc = makeService();
    const userId = '00000000-0000-0000-0000-000000000502';

    const first = await svc.accumulateExternalRound(db.drizzle.db, {
      gameId: created.id,
      userId,
      currency: 'USD',
      externalRoundId: 'ext-round-2',
      betDelta: '10',
    });
    const second = await svc.accumulateExternalRound(db.drizzle.db, {
      gameId: created.id,
      userId,
      currency: 'USD',
      externalRoundId: 'ext-round-2',
      betDelta: '5',
      winDelta: '20',
    });

    expect(second.roundId).toBe(first.roundId);
    expect(Number(second.betAmount)).toBe(15);
    expect(Number(second.winAmount)).toBe(20);
    const rows = await db.drizzle.db.select().from(gameRound);
    expect(rows).toHaveLength(1);
  });

  it('loses no update when two calls race against the same externalRoundId', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000b3', name: 'Aces' });
    const svc = makeService();
    const userId = '00000000-0000-0000-0000-000000000503';

    await Promise.all([
      svc.accumulateExternalRound(db.drizzle.db, {
        gameId: created.id,
        userId,
        currency: 'USD',
        externalRoundId: 'ext-round-3',
        betDelta: '10',
      }),
      svc.accumulateExternalRound(db.drizzle.db, {
        gameId: created.id,
        userId,
        currency: 'USD',
        externalRoundId: 'ext-round-3',
        betDelta: '7',
      }),
    ]);

    const rows = await db.drizzle.db.select().from(gameRound);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.betAmount)).toBe(17);
  });

  it('rolls back the accumulated round together with the caller transaction', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000b4', name: 'Aces' });
    const svc = makeService();
    const userId = '00000000-0000-0000-0000-000000000504';

    await expect(
      db.drizzle.db.transaction(async (tx) => {
        await svc.accumulateExternalRound(tx, {
          gameId: created.id,
          userId,
          currency: 'USD',
          externalRoundId: 'ext-round-4',
          betDelta: '10',
        });
        throw new Error('caller rolled back');
      }),
    ).rejects.toThrow('caller rolled back');

    const rows = await db.drizzle.db
      .select()
      .from(gameRound)
      .where(eq(gameRound.externalRoundId, 'ext-round-4'));
    expect(rows).toHaveLength(0);
  });

  it('marks the round completed with endedAt set when the terminating callback passes isFinal', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000b5', name: 'Aces' });
    const svc = makeService();
    const userId = '00000000-0000-0000-0000-000000000505';

    await svc.accumulateExternalRound(db.drizzle.db, {
      gameId: created.id,
      userId,
      currency: 'USD',
      externalRoundId: 'ext-round-5',
      betDelta: '10',
    });
    const result = await svc.accumulateExternalRound(db.drizzle.db, {
      gameId: created.id,
      userId,
      currency: 'USD',
      externalRoundId: 'ext-round-5',
      winDelta: '15',
      isFinal: true,
    });

    const rows = await db.drizzle.db
      .select()
      .from(gameRound)
      .where(eq(gameRound.id, result.roundId));
    expect(rows[0]).toMatchObject({ status: 'completed' });
    expect(rows[0]?.endedAt).not.toBeNull();
  });

  it('refuses to merge a delta onto a round owned by a different user', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000b6', name: 'Aces' });
    const svc = makeService();
    const ownerId = '00000000-0000-0000-0000-000000000506';
    const otherId = '00000000-0000-0000-0000-000000000507';

    await svc.accumulateExternalRound(db.drizzle.db, {
      gameId: created.id,
      userId: ownerId,
      currency: 'USD',
      externalRoundId: 'ext-round-6',
      betDelta: '10',
    });

    await expect(
      svc.accumulateExternalRound(db.drizzle.db, {
        gameId: created.id,
        userId: otherId,
        currency: 'USD',
        externalRoundId: 'ext-round-6',
        betDelta: '5',
      }),
    ).rejects.toThrow(ExternalRoundOwnerMismatchError);

    const rows = await db.drizzle.db
      .select()
      .from(gameRound)
      .where(eq(gameRound.externalRoundId, 'ext-round-6'));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.betAmount)).toBe(10);
  });

  it('preserves a sub-cent crypto delta instead of rounding it to zero', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000b7', name: 'Aces' });
    const svc = makeService();
    const userId = '00000000-0000-0000-0000-000000000508';

    const result = await svc.accumulateExternalRound(db.drizzle.db, {
      gameId: created.id,
      userId,
      currency: 'BTC',
      externalRoundId: 'ext-round-7',
      betDelta: '0.000000000000000001',
    });

    expect(result.betAmount).toBe('0.000000000000000001');
  });
});

describe('provider changes during ranking', () => {
  it('invalidates an in-flight playable pin projection through the game update service', async () => {
    const category = await seedCategory({ sortKey: 'provider_switch', rankDirtyAt: new Date() });
    const alpha = await seedGame({ name: 'Alpha' }, [category.id]);
    const bravo = await seedGame({ name: 'Bravo' }, [category.id]);
    const inactive = await seedProvider({ isActive: false });
    await db.drizzle.db
      .update(gameCategoryGame)
      .set({ pinnedPosition: 0 })
      .where(eq(gameCategoryGame.gameId, bravo.id));
    const gaming = makeService();
    let calls = 0;
    const definition = defineGameSort({
      key: 'provider_switch',
      directions: ['asc'],
      paramsSchema: z.object({}),
      async rank() {
        calls += 1;
        if (calls === 1) {
          await gaming.updateGame({ id: bravo.id, providerId: inactive.id, ...ACTOR });
        }
        return [alpha.id, bravo.id];
      },
    });
    const ranking = new GameSortRankingService(
      db.drizzle,
      new GameSortService(createGameSortCatalog([definition])),
    );
    await ranking.rank(category.id);
    const [updated] = await db.drizzle.db
      .select()
      .from(gameCategory)
      .where(eq(gameCategory.id, category.id));
    expect(updated?.rankSeq).toBe(3);
    expect(calls).toBe(2);
    const ranks = await db.drizzle.db
      .select({ gameId: gameCategoryGame.gameId, rank: gameCategoryGame.rank })
      .from(gameCategoryGame)
      .where(eq(gameCategoryGame.categoryId, category.id));
    expect(ranks.find(({ gameId }) => gameId === alpha.id)?.rank).toBe(0);
    expect(ranks.find(({ gameId }) => gameId === bravo.id)?.rank).toBe(1);
    expect(updated?.rankedAt).not.toBeNull();
  });
});
