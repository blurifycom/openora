import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  AUDIT_WRITER,
  IDENTITY_READER,
  LEDGER_API_V1,
  PLAY_ELIGIBILITY,
  WALLET_COMMANDS,
  domainEventSchemas,
  type LedgerApiV1,
  type LedgerV1BetArgs,
  type LedgerV1MoveOutcome,
  type PlayEligibilityPort,
  type WalletCommands,
} from '@openora/core/contracts';
import {
  Container,
  DRIZZLE,
  EVENT_BUS,
  ModuleRegistryImpl,
  findOneOrThrow,
  moneyEquals,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateGaming } from '@openora/core/casino/migrate/gaming';
import { game, gameProvider, gameRound } from '@openora/core/casino/schema/gaming';
import { backfillLedgerGames } from '@openora/core/casino/seed/gaming';
import gamingPlugin from '@openora/core/casino/plugins/gaming';
import { mock, makeAuditWriter, makeEventBus, makeIdentityReader } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { ledgerApiRequest, wallet, walletBalance, walletTransaction } from '../schema/index.js';
import walletPlugin from '../plugin.js';

let db: TestDb;
let api: LedgerApiV1;
let walletCommands: WalletCommands;
const events = makeEventBus();
const PROVIDER = 'acme-games';

const unrestricted = mock<PlayEligibilityPort>({
  isRestricted: vi.fn().mockResolvedValue(false),
  checkPlay: vi.fn().mockResolvedValue(null),
});

beforeAll(async () => {
  db = await createTestDb([migrate, migrateGaming]);
  // The real wallet and gaming plugins, so the test also covers how LEDGER_API_V1 is bound.
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => events);
  container.register(AUDIT_WRITER, () => makeAuditWriter());
  container.register(IDENTITY_READER, () => makeIdentityReader());
  container.register(PLAY_ELIGIBILITY, () => unrestricted);
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  walletPlugin.register(registry);
  gamingPlugin.register(registry);
  api = container.get(LEDGER_API_V1);
  walletCommands = container.get(WALLET_COMMANDS);
});

afterAll(async () => {
  await db.drop();
});

async function seedGame(rtp = '0.96') {
  const provider = findOneOrThrow(
    await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: `studio-${randomUUID()}`, name: 'Studio', isActive: true })
      .returning(),
    new Error('seedGame: no provider'),
  );
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(game)
      .values({
        reviewStatus: 'approved',
        name: 'Game',
        slug: `game-${randomUUID()}`,
        providerId: provider.id,
        aggregator: 'direct',
        isActive: true,
        wagerProduct: 'casino',
        rtp,
      })
      .returning(),
    new Error('seedGame: no game'),
  );
  await backfillLedgerGames(db.drizzle.db);
  return row;
}

async function seedPlayer(balance = '100') {
  const userId = randomUUID();
  const row = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId, currency: 'USD' }).returning(),
    new Error('seedPlayer: no wallet'),
  );
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row.id, currency: 'USD', amount: balance });
  return { userId, walletId: row.id };
}

async function balanceOf(walletId: string) {
  const [row] = await db.drizzle.db
    .select({ amount: walletBalance.amount })
    .from(walletBalance)
    .where(and(eq(walletBalance.walletId, walletId), eq(walletBalance.currency, 'USD')));
  return row?.amount ?? '0';
}

async function txCount(walletId: string) {
  const rows = await db.drizzle.db
    .select({ id: walletTransaction.id })
    .from(walletTransaction)
    .where(eq(walletTransaction.walletId, walletId));
  return rows.length;
}

async function roundOf(externalRoundId: string) {
  return findOneOrThrow(
    await db.drizzle.db
      .select()
      .from(gameRound)
      .where(eq(gameRound.externalRoundId, externalRoundId)),
    new Error('roundOf: no round'),
  );
}

async function setup(balance = '100') {
  const g = await seedGame();
  const player = await seedPlayer(balance);
  const betArgs = (overrides: Partial<LedgerV1BetArgs> = {}): LedgerV1BetArgs => ({
    providerName: PROVIDER,
    providerRefId: `tx-${randomUUID()}`,
    userId: player.userId,
    gameId: g.id,
    externalRoundId: `round-${randomUUID()}`,
    currency: 'USD',
    amount: '10',
    ...overrides,
  });
  return { game: g, ...player, betArgs };
}

function expectMoved(outcome: LedgerV1MoveOutcome, status: 'applied' | 'replayed') {
  if (outcome.status !== status) {
    throw new Error(`expected ${status}, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

describe('Ledger API v1 bet (real PG)', () => {
  it('takes the stake, adds it to the round, and snapshots the wager inputs', async () => {
    const { walletId, betArgs } = await setup();
    const args = betArgs();

    const applied = expectMoved(await api.bet(args), 'applied');

    expect(moneyEquals(applied.balance, '90')).toBe(true);
    expect(moneyEquals(await balanceOf(walletId), '90')).toBe(true);
    const round = await roundOf(args.externalRoundId);
    expect(round.id).toBe(applied.roundId);
    expect(moneyEquals(round.betAmount, '10')).toBe(true);
    expect(round.wagerProduct).toBe('casino');
    expect(moneyEquals(round.rtp ?? '', '0.96')).toBe(true);
  });

  it('answers a replayed callback with the stored answer and moves nothing again', async () => {
    const { walletId, betArgs } = await setup();
    const args = betArgs();
    const applied = expectMoved(await api.bet(args), 'applied');

    const replayed = expectMoved(await api.bet({ ...args, amount: '10.00' }), 'replayed');

    expect(replayed.transactionId).toBe(applied.transactionId);
    expect(await txCount(walletId)).toBe(1);
    expect(moneyEquals(await balanceOf(walletId), '90')).toBe(true);
  });

  it('after a timeout, a retry with the same key returns the stored answer, not the live balance', async () => {
    const { walletId, userId, betArgs } = await setup();
    const args = betArgs();
    const applied = expectMoved(await api.bet(args), 'applied');
    await api.win({ ...args, providerRefId: `win-${randomUUID()}`, amount: '25' });

    const retried = expectMoved(await api.bet(args), 'replayed');

    expect(retried).toEqual({ ...applied, status: 'replayed' });
    expect(moneyEquals(await balanceOf(walletId), '115')).toBe(true);
    const live = await api.balance({ userId, currency: 'USD' });
    expect(live.status === 'ok' && moneyEquals(live.balance, '115')).toBe(true);
  });

  it.each([
    ['amount', { amount: '11' }],
    ['currency', { currency: 'EUR' }],
    ['user', { userId: randomUUID() }],
    ['round', { externalRoundId: 'another-round' }],
  ])('refuses the same key with a different %s as fingerprint_mismatch', async (_, change) => {
    const { walletId, betArgs } = await setup();
    const args = betArgs();
    await api.bet(args);

    expect(await api.bet({ ...args, ...change })).toEqual({
      status: 'refused',
      reason: 'fingerprint_mismatch',
    });
    expect(await txCount(walletId)).toBe(1);
    expect(moneyEquals(await balanceOf(walletId), '90')).toBe(true);
  });

  it.each(['0', '-5', 'abc'])('refuses a stake of %s as invalid_amount', async (amount) => {
    const { walletId, betArgs } = await setup();

    expect(await api.bet(betArgs({ amount }))).toEqual({
      status: 'refused',
      reason: 'invalid_amount',
    });
    expect(await txCount(walletId)).toBe(0);
  });

  it('refuses a stake above the balance and leaves no round behind', async () => {
    const { betArgs } = await setup('5');
    const args = betArgs();

    expect(await api.bet(args)).toMatchObject({
      status: 'refused',
      reason: 'insufficient_funds',
    });
    const rounds = await db.drizzle.db
      .select()
      .from(gameRound)
      .where(eq(gameRound.externalRoundId, args.externalRoundId));
    expect(rounds).toHaveLength(0);
  });

  it('refuses a stake on a game the round ledger does not know', async () => {
    const { betArgs } = await setup();

    expect(await api.bet(betArgs({ gameId: randomUUID() }))).toEqual({
      status: 'refused',
      reason: 'unknown_game',
    });
  });

  it('settles concurrent bets on one wallet without overdrawing it', async () => {
    const { walletId, betArgs } = await setup('100');
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => api.bet(betArgs({ amount: '20' }))),
    );

    expect(outcomes.filter((o) => o.status === 'applied')).toHaveLength(5);
    expect(
      outcomes.filter((o) => o.status === 'refused' && o.reason === 'insufficient_funds'),
    ).toHaveLength(3);
    expect(moneyEquals(await balanceOf(walletId), '0')).toBe(true);
  });

  it('applies one of several concurrent deliveries of the same key and replays the rest', async () => {
    const { walletId, betArgs } = await setup('100');
    const args = betArgs();
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => api.bet(args)));

    expect(outcomes.filter((o) => o.status === 'applied')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'replayed')).toHaveLength(4);
    expect(await txCount(walletId)).toBe(1);
    expect(moneyEquals(await balanceOf(walletId), '90')).toBe(true);
  });

  it('answers a key the wallet already holds from a direct debit as replayed, storing nothing', async () => {
    const { walletId, userId, betArgs } = await setup();
    const args = betArgs();
    await walletCommands.debit(db.drizzle.db, {
      userId,
      amount: '10',
      currency: 'USD',
      type: 'bet',
      context: { provider: PROVIDER, product: 'casino', gameId: args.gameId },
      providerRef: {
        providerName: PROVIDER,
        providerRefId: args.providerRefId,
        externalRoundId: args.externalRoundId,
      },
    });

    expect(await api.bet(args)).toMatchObject({ status: 'replayed' });
    expect(await txCount(walletId)).toBe(1);
    const stored = await db.drizzle.db
      .select()
      .from(ledgerApiRequest)
      .where(eq(ledgerApiRequest.providerRefId, args.providerRefId));
    expect(stored).toHaveLength(0);
  });
});

describe('Ledger API v1 reverse (real PG)', () => {
  it('returns the stake once; another key is refused already_reversed, the same key replays', async () => {
    const { walletId, userId, game: g, betArgs } = await setup();
    const bet = betArgs();
    await api.bet(bet);
    const reverse = {
      providerName: PROVIDER,
      providerRefId: `rb-${randomUUID()}`,
      userId,
      gameId: g.id,
      targetRefId: bet.providerRefId,
    };

    const applied = expectMoved(await api.reverse(reverse), 'applied');

    expect(moneyEquals(applied.balance, '100')).toBe(true);
    expect(await api.reverse(reverse)).toMatchObject({ status: 'replayed' });
    expect(await api.reverse({ ...reverse, providerRefId: `rb-${randomUUID()}` })).toEqual({
      status: 'refused',
      reason: 'already_reversed',
    });
    expect(moneyEquals(await balanceOf(walletId), '100')).toBe(true);
    expect(moneyEquals((await roundOf(bet.externalRoundId)).reversedAmount, '10')).toBe(true);
  });

  it('handles a rollback that arrives before its bet', async () => {
    const { walletId, userId, game: g, betArgs } = await setup();
    const bet = betArgs({ reverseRef: `rb-${randomUUID()}` });
    const reverse = {
      providerName: PROVIDER,
      providerRefId: bet.reverseRef ?? '',
      userId,
      gameId: g.id,
      targetRefId: bet.providerRefId,
    };

    expect(await api.reverse(reverse)).toEqual({ status: 'refused', reason: 'bet_not_found' });

    const applied = expectMoved(await api.bet(bet), 'applied');
    expect(applied.reversalTransactionId).not.toBeNull();
    expect(moneyEquals(applied.balance, '100')).toBe(true);
    expect(await api.reverse(reverse)).toMatchObject({ status: 'replayed' });
    expect(await api.bet(bet)).toMatchObject({ status: 'replayed' });
    expect(await txCount(walletId)).toBe(2);
    expect(moneyEquals(await balanceOf(walletId), '100')).toBe(true);
  });

  it('refuses a reverse of another player bet as bet_not_found', async () => {
    const { game: g, betArgs } = await setup();
    const bet = betArgs();
    await api.bet(bet);
    const other = await seedPlayer();

    expect(
      await api.reverse({
        providerName: PROVIDER,
        providerRefId: `rb-${randomUUID()}`,
        userId: other.userId,
        gameId: g.id,
        targetRefId: bet.providerRefId,
      }),
    ).toEqual({ status: 'refused', reason: 'bet_not_found' });
  });
});

describe('Ledger API v1 win and round (real PG)', () => {
  it('pays a win, records a zero win without moving money, and ends the round on isFinal', async () => {
    const { walletId, betArgs } = await setup();
    const bet = betArgs();
    await api.bet(bet);
    events.emitInTransaction.mockClear();

    const lost = expectMoved(
      await api.win({ ...bet, providerRefId: `w-${randomUUID()}`, amount: '0', isFinal: true }),
      'applied',
    );

    expect(lost.transactionId).toBeNull();
    expect(moneyEquals(lost.balance, '90')).toBe(true);
    expect(await txCount(walletId)).toBe(1);
    expect((await roundOf(bet.externalRoundId)).status).not.toBe('open');
    expect(events.emitInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'gaming.round.ended',
      expect.objectContaining({ roundId: lost.roundId }),
    );
  });

  it('closes a round with its totals, and answers a balance read for an unknown player', async () => {
    const { userId, game: g, betArgs } = await setup();
    const bet = betArgs();
    await api.bet(bet);

    const closed = await api.closeRound({
      userId,
      gameId: g.id,
      externalRoundId: bet.externalRoundId,
      currency: 'USD',
    });

    expect(moneyEquals(closed.betAmount, '10')).toBe(true);
    expect(moneyEquals(closed.winAmount, '0')).toBe(true);
    expect(await api.balance({ userId: randomUUID(), currency: 'USD' })).toEqual({
      status: 'refused',
      reason: 'wallet_not_found',
    });
  });

  it('refuses a negative win as invalid_amount', async () => {
    const { betArgs } = await setup();

    expect(await api.win({ ...betArgs(), amount: '-1' })).toEqual({
      status: 'refused',
      reason: 'invalid_amount',
    });
  });
});

describe('Round wager snapshot (real PG)', () => {
  it('keeps the round snapshot when the catalogue rtp changes; a new round takes the new value', async () => {
    const { game: g, betArgs } = await setup();
    const first = betArgs();
    await api.bet(first);

    await db.drizzle.db.update(game).set({ rtp: '0.9' }).where(eq(game.id, g.id));
    await backfillLedgerGames(db.drizzle.db);
    await api.bet(betArgs({ externalRoundId: first.externalRoundId }));
    const next = betArgs();
    await api.bet(next);

    expect(moneyEquals((await roundOf(first.externalRoundId)).rtp ?? '', '0.96')).toBe(true);
    expect(moneyEquals((await roundOf(next.externalRoundId)).rtp ?? '', '0.9')).toBe(true);
  });

  it('carries the wager inputs on the projected event, as a fraction only', () => {
    const projected = (rtp: string) =>
      domainEventSchemas['gaming.ledger_game.projected'].safeParse({
        games: [
          {
            gameId: randomUUID(),
            providerId: randomUUID(),
            gameType: 'casino',
            wagerProduct: 'live-casino',
            rtp,
            version: 1,
          },
        ],
      }).success;

    expect(projected('0.960000000000000000')).toBe(true);
    expect(projected('96')).toBe(false);
  });
});
