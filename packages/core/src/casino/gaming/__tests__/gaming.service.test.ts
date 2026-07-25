import { describe, it, expect, vi } from 'vitest';
import { mock, mockDb, makeDrizzle } from '../../../testing/mock.js';
import type { EventBus } from '@openora/core/server';
import type {
  GameAdapter,
  PlayEligibilityPort,
  WalletCommands,
  WalletDebitOutcome,
} from '@openora/core/contracts';
import {
  GamingService,
  GameNotFoundError,
  GameRoundNotFoundError,
  RgRestrictedError,
  InsufficientBalanceError,
} from '../service/gaming.service.js';

describe('GamingService domain errors', () => {
  it('GameNotFoundError carries the id', () => {
    const err = new GameNotFoundError('game-abc');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GameNotFoundError');
    expect(err.message).toContain('game-abc');
  });

  it('GameRoundNotFoundError carries the id', () => {
    const err = new GameRoundNotFoundError('round-xyz');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GameRoundNotFoundError');
    expect(err.message).toContain('round-xyz');
  });
});

function makeQueryChain(rows: unknown[]) {
  const calls = { where: undefined as unknown };
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn((clause: unknown) => {
      calls.where = clause;
      return chain;
    }),
    orderBy: vi.fn().mockResolvedValue(rows),
  };
  return { chain, calls };
}

const noopEvents = mock<EventBus>({ emit: vi.fn(), on: vi.fn() });
const noopAdapter = mock<GameAdapter>({});

const eligibility = (isRestricted: boolean) =>
  mock<PlayEligibilityPort>({ isRestricted: vi.fn().mockResolvedValue(isRestricted) });

const unrestricted = eligibility(false);

function makeWalletCommands(debitResult: WalletDebitOutcome): WalletCommands {
  return mock<WalletCommands>({
    debit: vi.fn().mockResolvedValue(debitResult),
    credit: vi.fn(),
  });
}

const GAME_ROW = {
  id: 'g1',
  name: 'Aces',
  provider: 'mock',
  category: 'slots',
  thumbnailUrl: null,
  isActive: true,
  metadata: null,
};

describe('GamingService lobby', () => {
  it('listGames returns the active games', async () => {
    const query = makeQueryChain([GAME_ROW]);
    const drizzle = mockDb(query.chain);
    const svc = new GamingService(
      drizzle,
      noopEvents,
      noopAdapter,
      unrestricted,
      makeWalletCommands({ ok: true, newBalance: '0' }),
    );

    const games = await svc.listGames();

    expect(games).toHaveLength(1);
    expect(query.chain.select).toHaveBeenCalledOnce();
    expect(query.chain.where).toHaveBeenCalledOnce();
    expect(query.calls.where).toBeDefined();
  });
});

describe('GamingService responsible-gambling gate', () => {
  it('startRound refuses a restricted player before touching the provider', async () => {
    const launchGame = vi.fn();
    const svc = new GamingService(
      mockDb(makeQueryChain([]).chain),
      noopEvents,
      mock<GameAdapter>({ launchGame }),
      eligibility(true),
      makeWalletCommands({ ok: true, newBalance: '0' }),
    );

    await expect(svc.startRound('user-1', 'game-1', 'EUR', '10')).rejects.toBeInstanceOf(
      RgRestrictedError,
    );
    expect(launchGame).not.toHaveBeenCalled();
  });

  it('startRound passes the gate for an unrestricted player and fails later on the game lookup', async () => {
    const launchGame = vi.fn();
    const svc = new GamingService(
      mockDb(makeQueryChain([]).chain),
      noopEvents,
      mock<GameAdapter>({ launchGame }),
      unrestricted,
      makeWalletCommands({ ok: true, newBalance: '0' }),
    );

    await expect(svc.startRound('user-1', 'missing-game', 'EUR', '10')).rejects.toBeInstanceOf(
      GameNotFoundError,
    );
    expect(launchGame).not.toHaveBeenCalled();
  });
});

describe('GamingService.startRound', () => {
  it('debits the stake and persists the round on sufficient balance', async () => {
    const drizzle = makeDrizzle({
      select: [[GAME_ROW]],
      returning: [
        [
          {
            id: 'round-1',
            gameId: 'g1',
            userId: 'u1',
            status: 'active',
            betAmount: '10',
            winAmount: '0',
            currency: 'USD',
            startedAt: new Date(),
            endedAt: null,
          },
        ],
      ],
    });
    const walletCommands = makeWalletCommands({ ok: true, newBalance: '90' });
    const adapter = mock<GameAdapter>({
      launchGame: vi.fn().mockResolvedValue({ launchUrl: 'https://mock/play', token: 'tok' }),
    });
    const svc = new GamingService(
      drizzle,
      noopEvents,
      adapter,
      unrestricted,
      walletCommands,
    );

    const result = await svc.startRound('u1', 'g1', 'USD', '10');

    expect(walletCommands.debit).toHaveBeenCalledWith(expect.anything(), {
      userId: 'u1',
      amount: '10',
      type: 'bet',
    });
    expect(result).toEqual({ roundId: 'round-1', launchUrl: 'https://mock/play', token: 'tok' });
  });

  it('throws InsufficientBalanceError and never launches the game when the debit fails', async () => {
    const drizzle = makeDrizzle({ select: [[GAME_ROW]] });
    const walletCommands = makeWalletCommands({ ok: false, available: '2' });
    const adapter = mock<GameAdapter>({ launchGame: vi.fn() });
    const svc = new GamingService(
      drizzle,
      noopEvents,
      adapter,
      unrestricted,
      walletCommands,
    );

    await expect(svc.startRound('u1', 'g1', 'USD', '10')).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );
    expect(adapter.launchGame).not.toHaveBeenCalled();
  });
});
