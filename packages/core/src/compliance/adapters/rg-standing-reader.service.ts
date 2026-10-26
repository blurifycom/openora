import {
  moneyCompare,
  sumInPivot,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import {
  MAX_RG_STANDING_WINDOWS,
  MAX_RG_STANDING_WINDOW_DAYS,
  type ExchangeRateReader,
  type PlayEligibilityPort,
  type RgStanding,
  type RgStandingQuery,
  type RgStandingReader,
  type RgStandingWindow,
  type User,
} from '@openora/core/contracts';
import {
  readActiveFlags,
  readExclusionFacts,
  readLimits,
  readMoneyByWindow,
  readPlayerCurrency,
  type RgMoneyMetric,
  type RgMoneyRow,
} from '../service/rg-standing.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type RgStandingReaderServiceDeps = {
  drizzle: DrizzleService;
  eligibility: PlayEligibilityPort;
  rates: ExchangeRateReader;
  /** The fx pivot every window is priced into (`resolveExchangeRatePivot`). */
  pivotCurrency: string;
};

function assertWindowDays(windowDays: readonly number[]): void {
  if (windowDays.length > MAX_RG_STANDING_WINDOWS) {
    throw new RangeError(`windowDays takes at most ${MAX_RG_STANDING_WINDOWS} windows`);
  }
  const valid = (days: number) =>
    Number.isInteger(days) && days >= 1 && days <= MAX_RG_STANDING_WINDOW_DAYS;
  if (!windowDays.every(valid)) {
    throw new RangeError(
      `each window must be a whole number of days from 1 to ${MAX_RG_STANDING_WINDOW_DAYS}`,
    );
  }
}

type StandingFacts = Omit<RgStanding, 'restricted' | 'pivotCurrency' | 'windows'> & {
  money: RgMoneyRow[];
};

async function readStandingFacts(
  tx: DrizzleTx,
  userId: User['id'],
  now: Date,
  windowStarts: readonly Date[],
): Promise<StandingFacts | null> {
  const playerCurrency = await readPlayerCurrency(tx, userId);
  if (playerCurrency === null) {
    return null;
  }
  return {
    ...(await readExclusionFacts(tx, userId, now)),
    activeFlags: await readActiveFlags(tx, userId),
    limits: await readLimits(tx, userId, playerCurrency, now),
    money: await readMoneyByWindow(tx, userId, windowStarts),
  };
}

/**
 * The compliance-owned `RG_STANDING_READER`. Reads only: a limit stored without a currency is
 * read in the player's currency and left as it is.
 */
export class RgStandingReaderService implements RgStandingReader {
  constructor(private readonly deps: RgStandingReaderServiceDeps) {}

  async getStanding(
    userId: User['id'],
    { windowDays }: RgStandingQuery,
  ): Promise<RgStanding | null> {
    assertWindowDays(windowDays);
    const now = new Date();
    const windowStarts = windowDays.map((days) => new Date(now.getTime() - days * DAY_MS));
    const facts = await this.deps.drizzle.db.transaction(
      (tx) => readStandingFacts(tx, userId, now, windowStarts),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    if (facts === null) {
      return null;
    }
    const { money, ...standing } = facts;
    const restricted = await this.deps.eligibility.isRestricted(userId);
    const windows: RgStandingWindow[] = [];
    for (const [index, days] of windowDays.entries()) {
      windows.push({ days, totals: await this.windowTotals(money, index) });
    }
    return { restricted, ...standing, pivotCurrency: this.deps.pivotCurrency, windows };
  }

  private async windowTotals(
    money: readonly RgMoneyRow[],
    index: number,
  ): Promise<RgStandingWindow['totals']> {
    const deposits = await this.priced(money, 'deposits', index);
    const bets = await this.priced(money, 'bets', index);
    const wins = await this.priced(money, 'wins', index);
    if (deposits === null || bets === null || wins === null) {
      return null;
    }
    return { deposits, bets, wins };
  }

  // A currency with nothing in this window needs no rate, so it cannot make the window unknown.
  private priced(money: readonly RgMoneyRow[], metric: RgMoneyMetric, index: number) {
    const rows = money
      .filter((row) => row.metric === metric)
      .map((row) => ({ currency: row.currency, total: row.totals.at(index) ?? '0' }))
      .filter((row) => moneyCompare(row.total, '0') !== 0);
    return sumInPivot(rows, this.deps.pivotCurrency, this.deps.rates);
  }
}
