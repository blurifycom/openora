import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
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
import { mock, makeEventBus, makeIdentityReader } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { game, gameRound } from '../schema/index.js';
import {
  GamingService,
  GameNotFoundError,
  RgRestrictedError,
  InsufficientBalanceError,
  WinCreditFailedError,
  ExternalRoundOwnerMismatchError,
} from '../service/gaming.service.js';

let db: TestDb;

const noopEvents = makeEventBus();

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
  gameGeoCheck,
}: {
  provider?: GameAdapter;
  playEligibility?: PlayEligibilityPort;
  walletCommands?: WalletCommands;
  rgLimits?: RgLimitsPort;
  gameGeoCheck?: GameGeoCheckPort;
} = {}) {
  return new GamingService(
    db.drizzle,
    noopEvents,
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
  return svc.startRound({ userId, gameId, currency, betAmount, ipAddress: '1.2.3.4' });
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
  it('denies a blocked game before debit, round insertion, or provider launch', async () => {
    const created = await seedGame({ name: 'Blocked' });
    const launchGame = vi.fn();
    const walletCommands = makeWalletCommands({ ok: true, newBalance: '90', currency: 'USD' });
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
    const walletCommands = makeWalletCommands({ ok: true, newBalance: '0', currency: 'USD' });
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

  it('debits the stake and persists the round on sufficient balance', async () => {
    const created = await seedGame({ id: '00000000-0000-0000-0000-0000000000a1', name: 'Aces' });
    const walletCommands = makeWalletCommands({ ok: true, newBalance: '90', currency: 'USD' });
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

    await startRound(svc, userId, created.id, 'USD', '10');

    expect(events.emit).not.toHaveBeenCalledWith(
      'wallet.bonus_rollover.completed',
      expect.anything(),
    );
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
    const walletCommands = makeWalletCommands({ ok: true, newBalance: '0', currency: 'USD' });
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
      { ok: true, newBalance: '0', currency: 'USD' },
      { ok: false, reason: 'wallet not found' },
    );
    const svc = makeService({ provider: settlingProvider('7'), walletCommands });

    await expect(svc.endRound(userId, round.id)).rejects.toBeInstanceOf(WinCreditFailedError);

    const [unsettled] = await db.drizzle.db.select().from(gameRound);
    expect(unsettled?.status).toBe('active');
    expect(Number(unsettled?.winAmount)).toBe(0);
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
