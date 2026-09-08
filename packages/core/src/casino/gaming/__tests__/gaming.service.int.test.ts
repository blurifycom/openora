import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type {
  GameAdapter,
  PlayEligibilityPort,
  RgLimitsPort,
  WalletCommands,
  WalletCreditOutcome,
  WalletDebitOutcome,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { mock, makeEventBus, makeIdentityReader, NO_CLIENT_META } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { game, gameCategory, gameCategoryGame, gameProvider, gameRound } from '../schema/index.js';
import {
  GamingService,
  GameNotFoundError,
  GameSlugTakenError,
  RgRestrictedError,
  InsufficientBalanceError,
  WinCreditFailedError,
} from '../service/gaming.service.js';
import { GameProviderNotFoundError } from '../service/game-provider.service.js';
import { GameCategoryNotFoundError } from '../service/game-category.service.js';

let db: TestDb;

const noopEvents = makeEventBus();

const ACTOR = { actorId: '00000000-0000-4000-8000-000000000001', ...NO_CLIENT_META };

const eligibility = (isRestricted: boolean) =>
  mock<PlayEligibilityPort>({ isRestricted: vi.fn().mockResolvedValue(isRestricted) });

const unrestricted = eligibility(false);

function makeWalletCommands(
  debitResult: WalletDebitOutcome,
  creditResult: WalletCreditOutcome = { ok: true, newBalance: '0' },
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
  walletCommands = makeWalletCommands({ ok: true, newBalance: '0', currency: 'USD' }),
  rgLimits,
  events = noopEvents,
}: {
  provider?: GameAdapter;
  playEligibility?: PlayEligibilityPort;
  walletCommands?: WalletCommands;
  rgLimits?: RgLimitsPort;
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
  );
}

async function seedProvider(overrides: Partial<typeof gameProvider.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameProvider)
    .values({ slug: `studio-${randomUUID()}`, name: 'Studio', isActive: true, ...overrides })
    .returning();
  return row!;
}

async function seedCategory(overrides: Partial<typeof gameCategory.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameCategory)
    .values({ slug: `category-${randomUUID()}`, name: 'Slots', ...overrides })
    .returning();
  return row!;
}

async function seedGame(overrides: Partial<typeof game.$inferInsert> = {}, categoryIds?: string[]) {
  const [provider] = await db.drizzle.db
    .insert(gameProvider)
    .values({ slug: `studio-${randomUUID()}`, name: 'Mock Studio', isActive: true })
    .returning();
  const ids = categoryIds ?? [(await seedCategory()).id];
  const [row] = await db.drizzle.db
    .insert(game)
    .values({
      name: 'Game',
      slug: `game-${randomUUID()}`,
      providerId: provider!.id,
      aggregator: 'direct',
      isActive: true,
      ...overrides,
    })
    .returning();
  await db.drizzle.db
    .insert(gameCategoryGame)
    .values(ids.map((categoryId) => ({ gameId: row!.id, categoryId })));
  return row!;
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${gameRound}, ${gameCategoryGame}, ${game}, ${gameProvider}, ${gameCategory} RESTART IDENTITY CASCADE`,
  );
});

describe('GamingService lobby (real PG)', () => {
  it('listGames paginates active games ordered by name', async () => {
    await seedGame({ name: 'Baccarat', isActive: true });
    await seedGame({ name: 'Aces', isActive: true });
    await seedGame({ name: 'Retired', isActive: false });

    const page = await makeService().listGames({ page: 1, limit: 10, isActive: true });

    expect(page.total).toBe(2);
    expect(page.items.map((g) => g.name)).toEqual(['Aces', 'Baccarat']);
  });

  it('listGames searches and filters by provider and category', async () => {
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

    expect((await svc.listGames({ page: 1, limit: 10, q: 'bonanza', isActive: true })).total).toBe(
      1,
    );
    expect(
      (await svc.listGames({ page: 1, limit: 10, providerId: p1.id, isActive: true })).items.map(
        (g) => g.slug,
      ),
    ).toEqual(['gates-of-olympus', 'sweet-bonanza']);
    expect(
      (await svc.listGames({ page: 1, limit: 10, categoryId: live.id, isActive: true })).total,
    ).toBe(1);
    expect(
      (await svc.listGames({ page: 1, limit: 10, categoryId: slots.id, isActive: true })).total,
    ).toBe(3);
  });

  it('getGame returns the row for a known id and 404s an unknown one', async () => {
    const table = await seedCategory({ slug: 'table-games', name: 'Table Games' });
    const blackjack = await seedCategory({ slug: 'blackjack', name: 'Blackjack' });
    const created = await seedGame({ name: 'Roulette' }, [table.id, blackjack.id]);
    const svc = makeService();

    expect(await svc.getGame(created.id)).toMatchObject({
      name: 'Roulette',
      categories: [{ slug: 'blackjack' }, { slug: 'table-games' }],
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
  it('refuses a wager over the players own limit before touching the provider', async () => {
    const launchGame = vi.fn();
    const walletCommands = makeWalletCommands({ ok: true, newBalance: '0', currency: 'USD' });
    const svc = makeService({
      provider: mock<GameAdapter>({ launchGame, endRound: vi.fn() }),
      walletCommands,
      rgLimits: refusingLimits(),
    });

    await expect(svc.startRound('user-1', 'game-1', 'EUR', '10')).rejects.toMatchObject({
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
      svc.startRound('00000000-0000-0000-0000-000000000111', created.id, 'USD', '10'),
    ).resolves.toMatchObject({ launchUrl: 'https://mock/play' });
  });

  it('refuses a restricted player before touching the provider', async () => {
    const launchGame = vi.fn();
    const svc = makeService({
      provider: mock<GameAdapter>({ launchGame, endRound: vi.fn() }),
      playEligibility: eligibility(true),
    });

    await expect(svc.startRound('user-1', 'game-1', 'EUR', '10')).rejects.toBeInstanceOf(
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
      svc.startRound(
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
    const walletCommands = makeWalletCommands({ ok: true, newBalance: '90', currency: 'USD' });
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

  it('404s a game on a deactivated provider without touching the wallet or provider', async () => {
    const created = await seedGame({ name: 'Orphaned' });
    await db.drizzle.db
      .update(gameProvider)
      .set({ isActive: false })
      .where(eq(gameProvider.id, created.providerId));
    const walletCommands = makeWalletCommands({ ok: true, newBalance: '90', currency: 'USD' });
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
    const walletCommands = makeWalletCommands({ ok: true, newBalance: '90', currency: 'USD' });
    const launchGame = vi.fn().mockResolvedValue({ launchUrl: 'https://mock/play', token: 'tok' });
    const svc = makeService({
      provider: mock<GameAdapter>({ launchGame, endRound: vi.fn() }),
      walletCommands,
    });

    const userId = '00000000-0000-0000-0000-000000000301';
    const result = await svc.startRound(userId, created.id, 'USD', '10');

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
      svc.startRound('00000000-0000-0000-0000-000000000302', created.id, 'USD', '10'),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(launchGame).not.toHaveBeenCalled();
    expect(await db.drizzle.db.select().from(gameRound)).toHaveLength(0);
  });
});

describe('GamingService listGames provider gate (real PG)', () => {
  it('hides games of deactivated providers from the active listing only', async () => {
    const live = await seedGame({ name: 'Live Game' });
    const hidden = await seedGame({ name: 'Hidden Game' });
    await db.drizzle.db
      .update(gameProvider)
      .set({ isActive: false })
      .where(eq(gameProvider.id, hidden.providerId));
    const svc = makeService();

    const pub = await svc.listGames({ page: 1, limit: 10, isActive: true });
    expect(pub.items.map((g) => g.id)).toEqual([live.id]);
    expect(pub.total).toBe(1);

    const admin = await svc.listGames({ page: 1, limit: 10 });
    expect(admin.total).toBe(2);
  });
});

describe('GamingService.startRound bonus rollover completion (real PG)', () => {
  it('emits wallet.bonus_rollover.completed once per credit the bet just completed', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000a3', name: 'Aces' });
    const events = makeEventBus();
    const walletCommands = makeWalletCommands({
      ok: true,
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

    await svc.startRound(userId, created.id, 'USD', '40');

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

    await expect(svc.startRound(userId, created.id, 'USD', '25')).rejects.toThrow(
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
    const walletCommands = makeWalletCommands({ ok: true, newBalance: '90', currency: 'USD' });
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

    await svc.startRound(userId, created.id, 'USD', '10');

    expect(events.emit).not.toHaveBeenCalledWith(
      'wallet.bonus_rollover.completed',
      expect.anything(),
    );
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
      ...NO_CLIENT_META,
    });
    expect(replaced.categories.map((c) => c.slug)).toEqual(['blackjack']);

    const cleared = await svc.updateGame({ id: created.id, categoryIds: [], ...NO_CLIENT_META });
    expect(cleared.categories).toEqual([]);
  });

  it('leaves links untouched when categoryIds is omitted', async () => {
    const table = await seedCategory({ slug: 'table-games', name: 'Table Games' });
    const created = await seedGame({}, [table.id]);
    const svc = makeService();

    const updated = await svc.updateGame({ id: created.id, name: 'Renamed', ...NO_CLIENT_META });
    expect(updated.categories.map((c) => c.slug)).toEqual(['table-games']);
  });

  it('reassigns the provider and validates all references', async () => {
    const created = await seedGame();
    const other = await seedProvider({ slug: 'other-studio', name: 'Other' });
    const svc = makeService();

    const updated = await svc.updateGame({
      id: created.id,
      providerId: other.id,
      ...NO_CLIENT_META,
    });
    expect(updated.provider).toMatchObject({ slug: 'other-studio' });

    await expect(
      svc.updateGame({
        id: created.id,
        providerId: '00000000-0000-4000-8000-000000000000',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(GameProviderNotFoundError);
    await expect(
      svc.updateGame({
        id: created.id,
        categoryIds: ['00000000-0000-4000-8000-000000000000'],
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(GameCategoryNotFoundError);
    await expect(
      svc.updateGame({
        id: '00000000-0000-4000-8000-000000000000',
        name: 'X',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(GameNotFoundError);
  });

  it('rejects a taken game slug', async () => {
    const created = await seedGame({ slug: 'game-one' });
    await seedGame({ slug: 'game-two' });
    const svc = makeService();

    await expect(
      svc.updateGame({ id: created.id, slug: 'game-two', ...NO_CLIENT_META }),
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

  it('credits the provider-reported win to the round currency and records it on the round', async () => {
    const created = await seedGame();
    const round = await seedRound(created.id, userId);
    const walletCommands = makeWalletCommands({ ok: true, newBalance: '0', currency: 'USD' });
    const svc = makeService({ provider: settlingProvider('42.50'), walletCommands });

    expect(await svc.endRound(userId, round.id)).toEqual({ success: true, winAmount: '42.50' });

    expect(walletCommands.credit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId, amount: '42.50', currency: 'USD', type: 'win' }),
    );
    const [settled] = await db.drizzle.db.select().from(gameRound);
    expect(settled).toMatchObject({ status: 'completed', winAmount: '42.50' });
  });

  it('credits nothing when the provider reports no outcome', async () => {
    const created = await seedGame();
    const round = await seedRound(created.id, userId);
    const walletCommands = makeWalletCommands({ ok: true, newBalance: '0', currency: 'USD' });
    const svc = makeService({ provider: settlingProvider(), walletCommands });

    expect(await svc.endRound(userId, round.id)).toEqual({ success: true, winAmount: '0' });

    expect(walletCommands.credit).not.toHaveBeenCalled();
  });

  it('pays a win once - a replayed end never asks the provider or credits again', async () => {
    const created = await seedGame();
    const round = await seedRound(created.id, userId);
    const walletCommands = makeWalletCommands({ ok: true, newBalance: '0', currency: 'USD' });
    const provider = settlingProvider('7');
    const svc = makeService({ provider, walletCommands });

    await svc.endRound(userId, round.id);
    expect(await svc.endRound(userId, round.id)).toEqual({ success: true, winAmount: '7.00' });

    expect(provider.endRound).toHaveBeenCalledOnce();
    expect(walletCommands.credit).toHaveBeenCalledOnce();
  });

  it('leaves the round open when the win credit is refused, so the payout is not lost', async () => {
    const created = await seedGame();
    const round = await seedRound(created.id, userId);
    const walletCommands = makeWalletCommands(
      { ok: true, newBalance: '0', currency: 'USD' },
      { ok: false, reason: 'wallet not found' },
    );
    const svc = makeService({ provider: settlingProvider('7'), walletCommands });

    await expect(svc.endRound(userId, round.id)).rejects.toBeInstanceOf(WinCreditFailedError);

    const [unsettled] = await db.drizzle.db.select().from(gameRound);
    expect(unsettled).toMatchObject({ status: 'active', winAmount: '0.00' });
  });
});
