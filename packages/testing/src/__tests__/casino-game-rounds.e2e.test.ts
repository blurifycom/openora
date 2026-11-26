import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { LEDGER_API_V1, LedgerV1MoveOutcomeSchema } from '@openora/core/contracts';
import { game, gameFavorite } from '@openora/core/casino/schema/gaming';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import { newPlayer } from '../index.js';
import { balanceOf, bootWalletE2e, closeWalletE2e, type WalletE2e } from './support/wallet.js';
import {
  ALLOWED_IP,
  bodyOf,
  DE_IP,
  endRoundAs,
  EndedRoundSchema,
  fundedBettor,
  gameAdapterPlugin,
  type Bettor,
  geoIpPlugin,
  allLedgerRowsOf,
  ledgerRowsOf,
  newGame,
  RoundViewSchema,
  roundRows,
  scaled,
  startedRound,
  startRound,
  StartedRoundSchema,
} from './support/casino.js';
import { endCallsFor, launchesOf, reportPayoutFor } from './support/test-game-adapter-plugin.js';

let e2e: WalletE2e;

beforeAll(async () => {
  e2e = await bootWalletE2e([geoIpPlugin, gameAdapterPlugin]);
}, 120_000);

afterAll(() => closeWalletE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

const GameListSchema = z.object({ items: z.array(z.object({ id: z.string() })) });
const IdListSchema = z.array(z.string());
const GameListEntrySchema = z.array(z.object({ id: z.string() }));
const ErrorSchema = z.object({ code: z.string(), status: z.number() });

describe('player launches a game and plays a round', () => {
  it('a signed-in player starts a round on an active game and receives a launch URL and a round row in the started state', async () => {
    const bettor = await fundedBettor(e2e);
    const { gameId } = await newGame(e2e);

    const res = await startRound(bettor, gameId, '1');

    expect(res.status).toBe(200);
    const started = StartedRoundSchema.parse(await bodyOf(res));
    expect(started.launchUrl).toContain(`gameId=${gameId}`);
    expect(started.token).not.toBe('');
    expect(await roundRows(e2e, bettor.userId)).toEqual([
      expect.objectContaining({
        id: started.roundId,
        gameId,
        status: 'active',
        betAmount: scaled('1'),
        winAmount: scaled('0'),
        currency: bettor.currency,
        endedAt: null,
      }),
    ]);
    expect(launchesOf(gameId)).toHaveLength(1);
  });

  it.todo(
    'BUG: a provider launch that fails after the stake is debited leaves the stake taken and an active round, with no refund (casino/gaming/service/gaming.service.ts:727-742)',
  );

  it('starting a round on an inactive or unknown game is refused and leaves the balance unchanged', async () => {
    const bettor = await fundedBettor(e2e);
    const inactive = await newGame(e2e, { isActive: false });
    const providerOff = await newGame(e2e, { providerActive: false });

    const refused = await Promise.all([
      startRound(bettor, inactive.gameId),
      startRound(bettor, providerOff.gameId),
      startRound(bettor, randomUUID()),
    ]);

    for (const res of refused) {
      expect(res.status).toBe(404);
      expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('NOT_FOUND');
    }
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(scaled('50'));
    expect(await roundRows(e2e, bettor.userId)).toEqual([]);
    expect(await ledgerRowsOf(e2e, bettor.userId, 'bet')).toEqual([]);
    expect(launchesOf(inactive.gameId)).toEqual([]);
  });

  it('a game disabled by an admin cannot be launched but its open round still settles and pays', async () => {
    const bettor = await fundedBettor(e2e);
    const { gameId } = await newGame(e2e);
    const open = await startedRound(bettor, gameId, '4');
    const disabled = await e2e.admin.post('/backoffice/gaming/games/bulk/active', {
      gameIds: [gameId],
      isActive: false,
    });
    expect(disabled.status).toBe(200);

    const refused = await startRound(bettor, gameId, '1');
    reportPayoutFor(open.roundId, '10');
    const settled = await endRoundAs(bettor.client, open.roundId);

    expect(refused.status).toBe(404);
    expect(settled.status).toBe(200);
    expect(EndedRoundSchema.parse(await bodyOf(settled)).winAmount).toBe('10');
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(scaled('56'));
    expect(await ledgerRowsOf(e2e, bettor.userId, 'bet')).toHaveLength(1);
    expect(await ledgerRowsOf(e2e, bettor.userId, 'win')).toHaveLength(1);
  });

  it('starting a round from a geo-restricted country is refused with the geo error and no round row', async () => {
    const bettor = await fundedBettor(e2e);
    const { gameId } = await newGame(e2e);
    const restricted = await e2e.admin.put(`/compliance/game-geo-rules/${gameId}`, {
      gameId,
      countryCodes: ['DE'],
      reason: 'licence gap',
    });
    expect(restricted.status).toBe(200);

    const refused = await startRound(bettor, gameId, '1', DE_IP);

    expect(refused.status).toBe(409);
    expect(await bodyOf(refused)).toEqual(
      expect.objectContaining({
        code: 'CONFLICT',
        data: expect.objectContaining({ reason: 'game_block', countryCode: 'DE' }),
      }),
    );
    expect(await roundRows(e2e, bettor.userId)).toEqual([]);
    expect(await ledgerRowsOf(e2e, bettor.userId, 'bet')).toEqual([]);
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(scaled('50'));
    expect(launchesOf(gameId)).toEqual([]);
  });

  it('a player with a self-excluded or closed account cannot start a round', async () => {
    const excluded = await fundedBettor(e2e);
    const closed = await fundedBettor(e2e);
    const liveExcluded = await fundedBettor(e2e);
    const liveClosed = await fundedBettor(e2e);
    const { gameId } = await newGame(e2e);
    const exclusion = await excluded.client.post('/compliance/rg/self-exclusion', {
      isPermanent: false,
      durationMonths: 6,
      confirm: true,
    });
    expect(exclusion.status).toBe(200);
    const closing = await e2e.admin.patch(`/players/${closed.playerId}`, { status: 'closed' });
    expect(closing.status).toBe(200);
    await db().update(user).set({ rgBlocked: true }).where(eq(user.id, liveExcluded.userId));
    await db().update(player).set({ status: 'closed' }).where(eq(player.userId, liveClosed.userId));

    const revoked = [await startRound(excluded, gameId), await startRound(closed, gameId)];
    const live = [await startRound(liveExcluded, gameId), await startRound(liveClosed, gameId)];

    for (const res of revoked) {
      expect(res.status).toBe(401);
    }
    for (const res of live) {
      expect(res.status).toBe(409);
      expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('CONFLICT');
    }
    for (const bettor of [excluded, closed, liveExcluded, liveClosed]) {
      expect(await roundRows(e2e, bettor.userId)).toEqual([]);
      expect(await ledgerRowsOf(e2e, bettor.userId, 'bet')).toEqual([]);
      expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(scaled('50'));
    }
    expect(launchesOf(gameId)).toEqual([]);
  });

  it('starting a round without a session is rejected as unauthorized', async () => {
    const bettor = await fundedBettor(e2e);
    const { gameId } = await newGame(e2e);

    const res = await e2e.app.app.request('/gaming/rounds/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': ALLOWED_IP },
      body: JSON.stringify({ gameId, currency: bettor.currency, betAmount: '1' }),
    });

    expect(res.status).toBe(401);
    expect(await roundRows(e2e, bettor.userId)).toEqual([]);
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(scaled('50'));
  });

  it('the bet is debited from the wallet before the round stake is accepted and the balance drops by exactly the stake', async () => {
    const bettor = await fundedBettor(e2e);
    const { gameId } = await newGame(e2e);

    const started = await startedRound(bettor, gameId, '12.345678901234567891');

    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe('37.654321098765432109');
    expect(await ledgerRowsOf(e2e, bettor.userId, 'bet')).toEqual([
      expect.objectContaining({
        amount: '12.345678901234567891',
        providerRefId: `bet:${started.roundId}`,
      }),
    ]);
  });

  it('a bet larger than the available balance is refused and neither the round nor the ledger changes', async () => {
    const bettor = await fundedBettor(e2e, '10');
    const { gameId } = await newGame(e2e);

    const refused = await startRound(bettor, gameId, '10.000000000000000001');

    expect(refused.status).toBe(400);
    expect(ErrorSchema.parse(await bodyOf(refused)).code).toBe('BAD_REQUEST');
    expect(await roundRows(e2e, bettor.userId)).toEqual([]);
    expect(await ledgerRowsOf(e2e, bettor.userId, 'bet')).toEqual([]);
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(scaled('10'));
    const exact = await startRound(bettor, gameId, '10');
    expect(exact.status).toBe(200);
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(scaled('0'));
  });

  it('ending a round with a valid win amount credits the win once and marks the round ended', async () => {
    const bettor = await fundedBettor(e2e);
    const { gameId } = await newGame(e2e);
    const { roundId } = await startedRound(bettor, gameId, '1');
    reportPayoutFor(roundId, '5.5');

    const res = await endRoundAs(bettor.client, roundId);

    expect(res.status).toBe(200);
    expect(EndedRoundSchema.parse(await bodyOf(res)).winAmount).toBe('5.5');
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe('54.500000000000000000');
    expect(await ledgerRowsOf(e2e, bettor.userId, 'win')).toEqual([
      expect.objectContaining({ amount: '5.500000000000000000', providerRefId: `win:${roundId}` }),
    ]);
    const [round] = await roundRows(e2e, bettor.userId);
    expect(round).toMatchObject({ status: 'completed', winAmount: '5.500000000000000000' });
    expect(round?.endedAt).toBeInstanceOf(Date);
  });

  it('ending the same round twice credits the win only once', async () => {
    const bettor = await fundedBettor(e2e);
    const { gameId } = await newGame(e2e);
    const { roundId } = await startedRound(bettor, gameId, '1');
    reportPayoutFor(roundId, '5');

    const concurrent = await Promise.all([
      endRoundAs(bettor.client, roundId),
      endRoundAs(bettor.client, roundId),
      endRoundAs(bettor.client, roundId),
    ]);
    const providerCallsAfterRace = endCallsFor(roundId).length;
    const sequential = [
      await endRoundAs(bettor.client, roundId),
      await endRoundAs(bettor.client, roundId),
    ];

    for (const res of concurrent) {
      expect(res.status).toBe(200);
    }
    for (const res of sequential) {
      expect(res.status).toBe(200);
      expect(Number(EndedRoundSchema.parse(await bodyOf(res)).winAmount)).toBe(5);
    }
    expect(await ledgerRowsOf(e2e, bettor.userId, 'win')).toHaveLength(1);
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(scaled('54'));
    expect(endCallsFor(roundId)).toHaveLength(providerCallsAfterRace);
  });

  it.todo(
    'BUG: a caller that loses the race to end a round is told a win of 0 instead of the settled amount, because it returns the win read before the payout (casino/gaming/service/gaming.service.ts:830)',
  );

  it('ending a round with a negative or non-numeric win amount is refused and credits nothing', async () => {
    const bettor = await fundedBettor(e2e);
    const { gameId } = await newGame(e2e);
    const { roundId } = await startedRound(bettor, gameId, '1');

    for (const invalid of ['-5', 'abc', '1.0000000000000000001']) {
      reportPayoutFor(roundId, invalid);
      const res = await endRoundAs(bettor.client, roundId);
      expect(res.status).toBe(500);
      expect(ErrorSchema.parse(await bodyOf(res)).code).toBe('INTERNAL_SERVER_ERROR');
    }

    expect(await ledgerRowsOf(e2e, bettor.userId, 'win')).toEqual([]);
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(scaled('49'));
    const [round] = await roundRows(e2e, bettor.userId);
    expect(round).toMatchObject({ status: 'active', winAmount: scaled('0'), endedAt: null });
    reportPayoutFor(roundId, '2');
    const settled = await endRoundAs(bettor.client, roundId);
    expect(settled.status).toBe(200);
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(scaled('51'));
  });

  it('a player cannot end a round that belongs to another player', async () => {
    const owner = await fundedBettor(e2e);
    const intruder = await fundedBettor(e2e);
    const { gameId } = await newGame(e2e);
    const { roundId } = await startedRound(owner, gameId, '1');
    reportPayoutFor(roundId, '9');

    const res = await endRoundAs(intruder.client, roundId);

    expect(res.status).toBe(404);
    expect(await ledgerRowsOf(e2e, owner.userId, 'win')).toEqual([]);
    expect(await ledgerRowsOf(e2e, intruder.userId, 'win')).toEqual([]);
    expect(await balanceOf(e2e, intruder.userId, intruder.currency)).toBe(scaled('50'));
    const [round] = await roundRows(e2e, owner.userId);
    expect(round?.status).toBe('active');
    expect(endCallsFor(roundId)).toEqual([]);
  });

  it('rolling back a round restores the stake exactly once and a repeated rollback changes nothing', async () => {
    const bettor = await fundedBettor(e2e);
    const { gameId } = await newGame(e2e);
    const ledger = e2e.app.container.get(LEDGER_API_V1);
    const vendor = `vendor-${randomUUID().slice(0, 8)}`;
    const roundRef = `round-${randomUUID()}`;
    const betRef = `bet-${randomUUID()}`;
    const round = { userId: bettor.userId, gameId, currency: bettor.currency };
    const bet = LedgerV1MoveOutcomeSchema.parse(
      await ledger.bet({
        ...round,
        providerName: vendor,
        providerRefId: betRef,
        externalRoundId: roundRef,
        amount: '7',
        wager: { product: 'casino' },
      }),
    );
    expect(bet).toMatchObject({ status: 'applied' });
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(scaled('43'));
    const rollback = (providerRefId: string) =>
      ledger.reverse({
        userId: bettor.userId,
        gameId,
        providerName: vendor,
        providerRefId,
        targetRefId: betRef,
      });

    const first = LedgerV1MoveOutcomeSchema.parse(await rollback('rb-1'));
    const sameKey = LedgerV1MoveOutcomeSchema.parse(await rollback('rb-1'));
    const otherKey = LedgerV1MoveOutcomeSchema.parse(await rollback('rb-2'));

    expect(first.status).toBe('applied');
    expect(sameKey.status).toBe('replayed');
    expect(otherKey).toEqual({ status: 'refused', reason: 'already_reversed' });
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(scaled('50'));
    const moves = (await allLedgerRowsOf(e2e, bettor.userId)).filter((row) =>
      [betRef, 'rb-1', 'rb-2'].includes(row.providerRefId ?? ''),
    );
    expect(moves).toHaveLength(2);
    expect(moves).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerRefId: betRef,
          direction: 'debit',
          amount: '7.000000000000000000',
        }),
        expect.objectContaining({
          providerRefId: 'rb-1',
          direction: 'credit',
          amount: '7.000000000000000000',
        }),
      ]),
    );
    const rounds = await roundRows(e2e, bettor.userId);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ betAmount: scaled('0'), reversedAmount: scaled('7') });
  });

  it("the player round list returns only the caller's rounds in newest-first order", async () => {
    const bettor = await fundedBettor(e2e);
    const other = await fundedBettor(e2e);
    const { gameId } = await newGame(e2e);
    const first = await startedRound(bettor, gameId, '1');
    const second = await startedRound(bettor, gameId, '2');
    const third = await startedRound(bettor, gameId, '3');
    const foreign = await startedRound(other, gameId, '4');

    const res = await bettor.client.get('/gaming/rounds');

    expect(res.status).toBe(200);
    const rounds = z.array(RoundViewSchema).parse(await bodyOf(res));
    expect(rounds.map((round) => round.id)).toEqual([third.roundId, second.roundId, first.roundId]);
    expect(rounds.map((round) => round.id)).not.toContain(foreign.roundId);
    expect(rounds.every((round) => round.userId === bettor.userId)).toBe(true);
    const unauthenticated = await e2e.app.app.request('/gaming/rounds');
    expect(unauthenticated.status).toBe(401);
  });
});

describe('player favourites and catalog reads', () => {
  const favoriteRows = (userId: string) =>
    db().select().from(gameFavorite).where(eq(gameFavorite.userId, userId));

  const idsOf = (list: { id: string }[]) => list.map((entry) => entry.id);

  const favourite = (client: Bettor['client'], gameId: string) =>
    client.post('/gaming/favorites', { gameId });

  it('a player adds a game to favourites and it appears in the favourites list and id list', async () => {
    const bettor = await newPlayer(e2e.app, 'fav-add');
    const { gameId } = await newGame(e2e);
    const hidden = await newGame(e2e, { isActive: false });
    await db().insert(gameFavorite).values({ userId: bettor.userId, gameId: hidden.gameId });

    const added = await favourite(bettor.client, gameId);

    expect(added.status).toBe(200);
    expect(await bodyOf(added)).toEqual({ success: true });
    const list = await bettor.client.get('/gaming/favorites');
    const ids = await bettor.client.get('/gaming/favorites/ids');
    expect(idsOf(GameListEntrySchema.parse(await bodyOf(list)))).toEqual([gameId]);
    expect(IdListSchema.parse(await bodyOf(ids))).toEqual(
      expect.arrayContaining([gameId, hidden.gameId]),
    );
    const refused = await favourite(bettor.client, hidden.gameId);
    expect(refused.status).toBe(404);
  });

  it('adding the same favourite twice keeps a single row', async () => {
    const bettor = await newPlayer(e2e.app, 'fav-twice');
    const { gameId } = await newGame(e2e);

    const results = [
      await favourite(bettor.client, gameId),
      await favourite(bettor.client, gameId),
      ...(await Promise.all([favourite(bettor.client, gameId), favourite(bettor.client, gameId)])),
    ];

    for (const res of results) {
      expect(res.status).toBe(200);
    }
    expect(await favoriteRows(bettor.userId)).toEqual([expect.objectContaining({ gameId })]);
    const ids = await bettor.client.get('/gaming/favorites/ids');
    expect(IdListSchema.parse(await bodyOf(ids))).toEqual([gameId]);
  });

  it("removing a favourite that is not set is a no-op for the caller and never touches another player's favourites", async () => {
    const owner = await newPlayer(e2e.app, 'fav-owner');
    const other = await newPlayer(e2e.app, 'fav-other');
    const kept = await newGame(e2e);
    const unrelated = await newGame(e2e);
    expect((await favourite(owner.client, kept.gameId)).status).toBe(200);
    expect((await favourite(other.client, kept.gameId)).status).toBe(200);

    const notSet = await other.client.del(`/gaming/favorites/${unrelated.gameId}`);
    const removed = await other.client.del(`/gaming/favorites/${kept.gameId}`);
    const again = await other.client.del(`/gaming/favorites/${kept.gameId}`);

    expect(notSet.status).toBe(200);
    expect(removed.status).toBe(200);
    expect(again.status).toBe(200);
    expect(await favoriteRows(other.userId)).toEqual([]);
    expect(await favoriteRows(owner.userId)).toEqual([
      expect.objectContaining({ gameId: kept.gameId }),
    ]);
  });

  it('listing favourites without a session is rejected as unauthorized', async () => {
    const { gameId } = await newGame(e2e);

    const list = await e2e.app.app.request('/gaming/favorites');
    const ids = await e2e.app.app.request('/gaming/favorites/ids');
    const add = await e2e.app.app.request('/gaming/favorites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gameId }),
    });

    expect(list.status).toBe(401);
    expect(ids.status).toBe(401);
    expect(add.status).toBe(401);
  });

  it('listing games filters by provider, category and search term and never returns inactive games', async () => {
    const token = `zq${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const alpha = await newGame(e2e, { name: `${token} alpha` });
    const beta = await newGame(e2e, { name: 'plain beta', providerId: alpha.providerId });
    const dormant = await newGame(e2e, {
      name: `${token} dormant`,
      providerId: alpha.providerId,
      isActive: false,
    });
    const foreign = await newGame(e2e, { name: `${token} foreign` });
    const category = await e2e.admin.post('/backoffice/gaming/categories', {
      slug: `cat-${randomUUID()}`,
      name: 'Read filter',
    });
    expect(category.status).toBe(200);
    const categoryId = z.object({ id: z.string() }).parse(await bodyOf(category)).id;
    const linked = await e2e.admin.post('/backoffice/gaming/games/bulk/categories', {
      gameIds: [alpha.gameId, dormant.gameId],
      categoryIds: [categoryId],
    });
    expect(linked.status).toBe(200);
    const list = async (query: Record<string, string>) => {
      const res = await e2e.app.app.request(`/gaming/games?${new URLSearchParams(query)}`);
      expect(res.status).toBe(200);
      return idsOf(GameListSchema.parse(await bodyOf(res)).items);
    };

    const byProvider = await list({ providerId: alpha.providerId });
    const byCategory = await list({ categoryId });
    const bySearch = await list({ q: token });
    const bySearchAndProvider = await list({ q: token, providerId: alpha.providerId });

    expect([...byProvider].sort()).toEqual([alpha.gameId, beta.gameId].sort());
    expect(byCategory).toEqual([alpha.gameId]);
    expect([...bySearch].sort()).toEqual([alpha.gameId, foreign.gameId].sort());
    expect(bySearchAndProvider).toEqual([alpha.gameId]);
    for (const ids of [byProvider, byCategory, bySearch, bySearchAndProvider]) {
      expect(ids).not.toContain(dormant.gameId);
    }
  });

  it('getting a game by an unknown slug returns not found', async () => {
    const known = await newGame(e2e);
    const inactive = await newGame(e2e, { isActive: false });
    const [inactiveRow] = await db().select().from(game).where(eq(game.id, inactive.gameId));

    const unknown = await e2e.app.app.request(`/gaming/games/by-slug/no-such-game-${randomUUID()}`);
    const hidden = await e2e.app.app.request(`/gaming/games/by-slug/${inactiveRow?.slug}`);
    const visible = await e2e.app.app.request(`/gaming/games/by-slug/${known.slug}`);

    expect(unknown.status).toBe(404);
    expect(ErrorSchema.parse(await bodyOf(unknown)).code).toBe('NOT_FOUND');
    expect(hidden.status).toBe(404);
    expect(visible.status).toBe(200);
  });
});
