import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type {
  GameAdapter,
  PlayEligibilityPort,
  RgLimitsPort,
  WalletCommands,
  WalletDebitOutcome,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { mock, makeEventBus, makeIdentityReader } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { game, gameRound } from '../schema/index.js';
import {
  GamingService,
  GameNotFoundError,
  RgRestrictedError,
  InsufficientBalanceError,
} from '../service/gaming.service.js';

let db: TestDb;

const noopEvents = makeEventBus();

const eligibility = (isRestricted: boolean) =>
  mock<PlayEligibilityPort>({ isRestricted: vi.fn().mockResolvedValue(isRestricted) });

const unrestricted = eligibility(false);

function makeWalletCommands(debitResult: WalletDebitOutcome): WalletCommands {
  return mock<WalletCommands>({
    debit: vi.fn().mockResolvedValue(debitResult),
    credit: vi.fn(),
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
}: {
  provider?: GameAdapter;
  playEligibility?: PlayEligibilityPort;
  walletCommands?: WalletCommands;
  rgLimits?: RgLimitsPort;
} = {}) {
  return new GamingService(
    db.drizzle,
    noopEvents,
    provider,
    playEligibility,
    walletCommands,
    makeIdentityReader(),
    rgLimits,
  );
}

async function seedGame(overrides: Partial<typeof game.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(game)
    .values({ name: 'Game', provider: 'mock', category: 'slots', ...overrides })
    .returning();
  return row!;
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${gameRound}, ${game} RESTART IDENTITY CASCADE`);
});

describe('GamingService lobby (real PG)', () => {
  it('listGames returns only active games, ordered by name', async () => {
    await seedGame({ name: 'Baccarat', isActive: true });
    await seedGame({ name: 'Aces', isActive: true });
    await seedGame({ name: 'Retired', isActive: false });

    const games = await makeService().listGames();

    expect(games.map((g) => g.name)).toEqual(['Aces', 'Baccarat']);
  });

  it('getGame returns the row for a known id and 404s an unknown one', async () => {
    const created = await seedGame({ name: 'Roulette', category: 'table' });
    const svc = makeService();

    expect(await svc.getGame(created.id)).toMatchObject({ name: 'Roulette', category: 'table' });
    await expect(svc.getGame('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(
      GameNotFoundError,
    );
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

    // A translatable refusal, not a bare status code: startRound returns CONFLICT for an
    // exclusion too, so the client branches on `data.reason`.
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
