import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type {
  GameAdapter,
  PlayEligibilityPort,
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
}: {
  provider?: GameAdapter;
  playEligibility?: PlayEligibilityPort;
  walletCommands?: WalletCommands;
} = {}) {
  return new GamingService(
    db.drizzle,
    noopEvents,
    provider,
    playEligibility,
    walletCommands,
    makeIdentityReader(),
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

describe('GamingService.startRound (real PG)', () => {
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

describe('GamingService.accumulateExternalRound (real PG)', () => {
  it('creates a game_round row on the first call for a given externalRoundId', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000b1', name: 'Aces' });
    const svc = makeService();
    const userId = '00000000-0000-0000-0000-000000000501';

    const result = await svc.accumulateExternalRound({
      gameId: created.id,
      userId,
      currency: 'USD',
      externalRoundId: 'ext-round-1',
      betDelta: '10',
      winDelta: '0',
    });

    expect(result.betAmount).toBe('10.00');
    expect(result.winAmount).toBe('0.00');
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

    const first = await svc.accumulateExternalRound({
      gameId: created.id,
      userId,
      currency: 'USD',
      externalRoundId: 'ext-round-2',
      betDelta: '10',
    });
    const second = await svc.accumulateExternalRound({
      gameId: created.id,
      userId,
      currency: 'USD',
      externalRoundId: 'ext-round-2',
      betDelta: '5',
      winDelta: '20',
    });

    expect(second.roundId).toBe(first.roundId);
    expect(second.betAmount).toBe('15.00');
    expect(second.winAmount).toBe('20.00');
    const rows = await db.drizzle.db.select().from(gameRound);
    expect(rows).toHaveLength(1);
  });

  it('loses no update when two calls race against the same externalRoundId', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000b3', name: 'Aces' });
    const svc = makeService();
    const userId = '00000000-0000-0000-0000-000000000503';

    await Promise.all([
      svc.accumulateExternalRound({
        gameId: created.id,
        userId,
        currency: 'USD',
        externalRoundId: 'ext-round-3',
        betDelta: '10',
      }),
      svc.accumulateExternalRound({
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
});
