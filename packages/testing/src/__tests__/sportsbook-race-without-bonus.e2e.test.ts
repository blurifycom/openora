import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeE2e, type TestApp, type TestClient, type TestDb } from '../index.js';
import { mockSportsbookProviderState } from '../test-sportsbook-provider-plugin.js';
import {
  PROVIDER,
  acceptedBet,
  bootSportsbookApp,
  enableSportsbook,
  expectApplied,
  fundedPlayer,
  ledgerOf,
  txId,
} from './fixtures/sportsbook.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

beforeAll(async () => {
  ({ db, app } = await bootSportsbookApp({ without: ['bonus'] }));
  admin = await enableSportsbook(app);
}, 60_000);

afterAll(() => closeE2e({ app, db }));

beforeEach(() => mockSportsbookProviderState.reset());

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const settle = (providerBetId: string, result: 'won' | 'void', payout: string) =>
  ledgerOf(app)
    .settle({ provider: PROVIDER, providerTxId: txId(), providerBetId, result, payout })
    .then(expectApplied);

describe('a race counting sportsbook bets without the bonus plugin', () => {
  it('takes a voided stake back out of the race', async () => {
    const created = await admin.post('/backoffice/promo/races', {
      name: `Race ${randomUUID()}`,
      currency: 'USD',
      startAt: hoursFromNow(-1),
      endAt: hoursFromNow(24),
      prizePool: '100',
      positions: [{ position: 1, prize: '100' }],
      eligibleProducts: ['sportsbook'],
    });
    expect(created.status).toBe(200);
    const raceId = ((await created.json()) as { id: string }).id;
    const player = await fundedPlayer(app);
    const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    const wagered = async () => {
      const res = await player.client.get(`/promo/races/${raceId}`);
      expect(res.status).toBe(200);
      return Number(((await res.json()) as { own: { wagered: string } }).own.wagered);
    };

    await settle(args.providerBetId, 'won', '25');
    expect(await wagered()).toBe(10);

    await ledgerOf(app)
      .reopen({ provider: PROVIDER, providerTxId: txId(), providerBetId: args.providerBetId })
      .then(expectApplied);
    await settle(args.providerBetId, 'void', '10');
    expect(await wagered()).toBe(0);
  });
});
