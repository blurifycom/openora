import { createHash } from 'node:crypto';
import { and, eq, isNull, or } from 'drizzle-orm';
import {
  createLogger,
  findOneOrThrow,
  isPositiveMoney,
  isUniqueConstraintViolation,
  moneyCompare,
  moneyDivide,
  moneyEquals,
  moneyFloorToScale,
  type DrizzleDb,
  type DrizzleService,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import {
  MONEY_SCALE,
  RgLimitExceededError,
  SportsbookCancelArgsSchema,
  SportsbookConfirmArgsSchema,
  SportsbookReopenArgsSchema,
  SportsbookReserveArgsSchema,
  SportsbookSettleArgsSchema,
  WalletCorrectionExceedsRoundError,
  WalletCorrectionRefConflictError,
  type AuditWritePort,
  type DomainEventPayload,
  type ExchangeRateReader,
  type IdentityReader,
  type PlayEligibilityPort,
  type SportsbookBetLeg,
  type SportsbookBetResult,
  type SportsbookBetStatus,
  type SportsbookCancelArgs,
  type SportsbookConfirmArgs,
  type SportsbookLedgerApplied,
  type SportsbookLedgerOutcome,
  type SportsbookPromotion,
  type SportsbookRefusalReason,
  type SportsbookReopenArgs,
  type SportsbookReserveArgs,
  type SportsbookSessionArgs,
  type SportsbookSessionOutcome,
  type SportsbookSettleArgs,
  type User,
  type WalletCommands,
  type WalletCorrectionDebitArgs,
  type WalletReader,
  type WalletTransactionType,
} from '@openora/core/contracts';
import * as z from 'zod';
import {
  SPORTSBOOK_WALLET_PROVIDER_PREFIX,
  type SportsbookPromotionFunder,
  type SportsbookPromotionsConfig,
  type SportsbookTransactionKind,
} from '../contract/index.js';
import {
  sportsbookBet,
  sportsbookBetTransaction,
  sportsbookSession,
  type SportsbookBetRow,
  type SportsbookBetTransactionRow,
} from '../schema/index.js';
import { wallet } from '@openora/core/wallet/schema';
import type { SportsbookConfigService } from './config.service.js';
import type { DebtChange, SportsbookDebtService } from './debt.service.js';
import { fileFinding, type SportsbookFindingArgs } from './finding.service.js';
import { lockBet, lockConfig, lockPlayer } from './locks.service.js';
import { isPlayerRestricted, playRefusal } from './restriction-check.service.js';
import { isLiveSession, type SportsbookSessionService } from './session.service.js';

const logger = createLogger('sportsbook');

type ReserveArgs = z.output<typeof SportsbookReserveArgsSchema>;
type ConfirmArgs = z.output<typeof SportsbookConfirmArgsSchema>;
type CancelArgs = z.output<typeof SportsbookCancelArgsSchema>;
type SettleArgs = z.output<typeof SportsbookSettleArgsSchema>;
type ReopenArgs = z.output<typeof SportsbookReopenArgsSchema>;
type BetKey = Pick<ConfirmArgs, 'provider' | 'providerBetId'>;
type TxKey = Pick<ConfirmArgs, 'provider' | 'providerTxId'>;

const STATUS_AFTER = {
  reserve: 'reserved',
  confirm: 'accepted',
  cancel: 'cancelled',
  settle: 'settled',
  reopen: 'accepted',
} as const satisfies Record<SportsbookTransactionKind, SportsbookBetStatus>;

type WalletMove = {
  transactionId: string;
  amount: string;
  currency: string;
  type: WalletTransactionType;
  direction: 'credit' | 'debit';
};

export type StepHook = (tx: DrizzleTx, bet: SportsbookBetRow) => Promise<void>;

export type LedgerStep =
  | { kind: 'confirm'; args: SportsbookConfirmArgs }
  | { kind: 'cancel'; args: SportsbookCancelArgs }
  | { kind: 'settle'; args: SportsbookSettleArgs }
  | { kind: 'reopen'; args: SportsbookReopenArgs };

/** What a ledger step did, and what it announces and audits before its transaction commits. */
type LedgerResult = {
  outcome: SportsbookLedgerOutcome;
  userId?: User['id'];
  moves?: WalletMove[];
  announce?: (playerId: string | null) => Promise<void>;
  debt?: DebtChange;
};

/** Thrown inside a ledger transaction to roll it back and answer with a refusal. */
class LedgerRefusal extends Error {
  constructor(
    readonly reason: SportsbookRefusalReason,
    readonly finding?: SportsbookFindingArgs,
  ) {
    super(`sportsbook ledger refused: ${reason}`);
    this.name = 'LedgerRefusal';
  }
}

/** The wallet already holds this move's ref: a concurrent request with the same tx id committed first. */
class LedgerRaceLost extends Error {
  constructor(what: string) {
    super(`sportsbook ledger: the wallet replayed ${what} the ledger never recorded`);
    this.name = 'LedgerRaceLost';
  }
}

type FingerprintParts = {
  kind: SportsbookTransactionKind;
  provider: string;
  providerBetId: string;
  userId: User['id'] | null;
  amount?: string;
  potentialPayout?: string;
  currency?: string;
  result?: string;
  cancelReason?: string;
  version?: number;
  legs?: SportsbookBetLeg[];
  promotion?: SportsbookPromotion;
  promotionAmount?: string;
  promotionPotential?: string;
};

/** What identifies a leg: everything but its odds. */
function legIdentity(leg: SportsbookBetLeg): string {
  return JSON.stringify([
    leg.eventId,
    leg.eventName ?? null,
    leg.market ?? null,
    leg.selection ?? null,
    new Date(leg.startsAt).getTime(),
  ]);
}

const canonicalMoney = (amount: string | undefined) =>
  amount === undefined ? '' : moneyFloorToScale(amount, MONEY_SCALE);

/** Parts added after the first release are appended only when present, so older requests keep their hash. */
export function requestFingerprint(parts: FingerprintParts): string {
  const { promotion, promotionAmount, promotionPotential } = parts;
  const canonical = JSON.stringify([
    parts.kind,
    parts.provider,
    parts.providerBetId,
    parts.userId ?? '',
    canonicalMoney(parts.amount),
    canonicalMoney(parts.potentialPayout),
    parts.currency ?? '',
    parts.result ?? '',
    parts.cancelReason ?? '',
    parts.version ?? '',
    parts.legs?.map((leg) => [legIdentity(leg), leg.odds ?? null]) ?? '',
    ...(promotion
      ? [
          [
            'promotion',
            promotion.type,
            promotion.id ?? '',
            canonicalMoney(promotion.potentialAmount),
            promotion.stake,
            promotion.stake === 'promotion' ? promotion.voidReturnsStake : promotion.refundsLoss,
          ],
        ]
      : []),
    ...(promotionAmount === undefined
      ? []
      : [['promotionAmount', canonicalMoney(promotionAmount)]]),
    ...(promotionPotential === undefined
      ? []
      : [['promotionPotential', canonicalMoney(promotionPotential)]]),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

type ResolvedStake = Pick<SportsbookBetRow, 'cashStake' | 'voidPayout' | 'maxLossRefund'>;

/** What the player paid, what a void returns and the most a loss may refund, fixed at reserve. */
export function resolveStake(
  stake: string,
  promotion: SportsbookPromotion | undefined,
): ResolvedStake {
  if (promotion?.stake === 'promotion') {
    return {
      cashStake: '0',
      voidPayout: promotion.voidReturnsStake ? stake : '0',
      maxLossRefund: '0',
    };
  }
  return {
    cashStake: stake,
    voidPayout: stake,
    maxLossRefund: promotion?.refundsLoss ? stake : '0',
  };
}

/** A type label the funder map leaves out is the operator's. */
function promotionFunder(
  promotions: Pick<SportsbookPromotionsConfig, 'funder'>,
  type: string,
): SportsbookPromotionFunder {
  return (
    (Object.hasOwn(promotions.funder, type) ? promotions.funder[type] : undefined) ?? 'operator'
  );
}

const moneyMin = (a: string, b: string) => (moneyCompare(a, b) < 0 ? a : b);
const moneyMax = (a: string, b: string) => (moneyCompare(a, b) < 0 ? b : a);

/** The most of a player-paid stake's payout a promotion funds: none of a void, its loss refund, or its boost. */
function cashPromotionCeiling(
  bet: Pick<SportsbookBetRow, 'promotionPotential' | 'maxLossRefund'>,
  result: SportsbookBetResult,
  payout: string,
): string {
  const boost = bet.promotionPotential ?? '0';
  switch (result) {
    case 'void':
      return '0';
    case 'lost':
      return moneyMin(bet.maxLossRefund, payout);
    case 'half_lost':
      return moneyMin(moneyMax(bet.maxLossRefund, boost), payout);
    default:
      return moneyMin(boost, payout);
  }
}

/** The part of a payout a promotion funded, when the overlay leaves it out. */
export function defaultPromotionAmount(
  bet: Pick<SportsbookBetRow, 'cashStake' | 'promotionPotential' | 'maxLossRefund'>,
  result: SportsbookBetResult,
  payout: string,
): string {
  if (!isPositiveMoney(bet.cashStake) || result === 'lost') {
    return payout;
  }
  // A half loss returns half the player's own stake; only the overlay knows what a refund added.
  return result === 'half_lost' ? '0' : cashPromotionCeiling(bet, result, payout);
}

const DECIMAL_ODDS = /^\d+(?:\.\d+)?$/;

type Exact = { digits: bigint; scale: number };

const EXACT_ONE: Exact = { digits: 1n, scale: 0 };

/** Exact, untruncated: `digits / 10^scale` times a decimal string. */
function timesDecimal(product: Exact, decimal: string): Exact {
  const [whole, fraction = ''] = decimal.split('.');
  return {
    digits: product.digits * BigInt(`${whole}${fraction}`),
    scale: product.scale + fraction.length,
  };
}

function compareExact(a: Exact, b: Exact): number {
  const scale = Math.max(a.scale, b.scale);
  const left = a.digits * 10n ** BigInt(scale - a.scale);
  const right = b.digits * 10n ** BigInt(scale - b.scale);
  return left === right ? 0 : left > right ? 1 : -1;
}

/** True when a promotion-paid payout beats the stake times every leg's decimal odds. */
export function isUnusualPromotionPayout(
  bet: Pick<SportsbookBetRow, 'cashStake' | 'stake' | 'legs'>,
  payout: string,
): boolean {
  const odds = bet.legs.map((leg) => leg.odds);
  if (
    isPositiveMoney(bet.cashStake) ||
    odds.length === 0 ||
    !odds.every((o): o is string => o !== undefined && DECIMAL_ODDS.test(o))
  ) {
    return false;
  }
  const ceiling = odds.reduce(timesDecimal, timesDecimal(EXACT_ONE, bet.stake));
  return compareExact(timesDecimal(EXACT_ONE, payout), ceiling) > 0;
}

function fitsDecimals(amount: string, decimals: number): boolean {
  return moneyEquals(moneyFloorToScale(amount, decimals), amount);
}

/** Decimals fit the currency, a void pays its fixed amount (or 0 on a promotion-paid stake), and a loss at most its cap. */
export function isValidSettlement(
  bet: Pick<SportsbookBetRow, 'cashStake' | 'voidPayout' | 'maxLossRefund' | 'currencyDecimals'>,
  result: SportsbookBetResult,
  payout: string,
): boolean {
  return (
    fitsDecimals(payout, bet.currencyDecimals) &&
    (result !== 'void' ||
      moneyEquals(payout, bet.voidPayout) ||
      (!isPositiveMoney(bet.cashStake) && !isPositiveMoney(payout))) &&
    (result !== 'lost' || moneyCompare(payout, bet.maxLossRefund) <= 0)
  );
}

/** Fits the currency's decimals and pays back at least what the player staked in cash. */
function isValidPotentialPayout(payout: string, cashStake: string, decimals: number): boolean {
  return fitsDecimals(payout, decimals) && moneyCompare(payout, cashStake) >= 0;
}

/** A promotion's part of a potential payout fits the currency and the payout. */
function isValidPromotionPotential(amount: string, payout: string, decimals: number): boolean {
  return fitsDecimals(amount, decimals) && moneyCompare(amount, payout) <= 0;
}

/**
 * How the accepted odds move the combined odds of the legs that carry them: -1, 0 or 1. Null when
 * an odds is not a decimal, so its direction is unknown.
 */
function oddsDirection(reserved: SportsbookBetLeg[], accepted: SportsbookBetLeg[]): number | null {
  let before = EXACT_ONE;
  let after = EXACT_ONE;
  for (const [i, leg] of reserved.entries()) {
    const was = leg.odds ?? null;
    const now = accepted[i]?.odds ?? null;
    if (was === null || now === null) {
      continue;
    }
    if (!DECIMAL_ODDS.test(was) || !DECIMAL_ODDS.test(now)) {
      return null;
    }
    before = timesDecimal(before, was);
    after = timesDecimal(after, now);
  }
  return compareExact(after, before);
}

/**
 * The fields of accepted terms that do not fit the reserved bet. The terms come as a pair, the legs
 * may change only their odds, and the payout moves with the combined odds: up when they rise, down
 * when they fall, not at all when they hold. Odds that are not decimals only let the payout change.
 * A promotion part needs the pair and a promotion bet, may change only when the odds moved, and is
 * required once the stored one no longer fits the new payout.
 */
function invalidTerms(
  bet: Pick<
    SportsbookBetRow,
    | 'cashStake'
    | 'potentialPayout'
    | 'currencyDecimals'
    | 'legs'
    | 'promotionType'
    | 'promotionPotential'
  >,
  {
    potentialPayout,
    legs,
    promotionPotential,
  }: Pick<ConfirmArgs, 'potentialPayout' | 'legs' | 'promotionPotential'>,
): string[] {
  if (potentialPayout === undefined && legs === undefined) {
    return promotionPotential === undefined ? [] : ['promotionPotential'];
  }
  if (potentialPayout === undefined || legs === undefined) {
    return [potentialPayout === undefined ? 'potentialPayout' : 'legs'];
  }
  const shape = (of: SportsbookBetLeg[]) =>
    JSON.stringify(of.map((leg) => [legIdentity(leg), (leg.odds ?? null) === null]));
  const sameLegs = shape(legs) === shape(bet.legs);
  const payoutMove = moneyCompare(potentialPayout, bet.potentialPayout);
  const direction = oddsDirection(bet.legs, legs);
  const oddsTextChanged = bet.legs.some((leg, i) => (leg.odds ?? null) !== (legs[i]?.odds ?? null));
  const payoutFollowsOdds =
    direction === null ? oddsTextChanged || payoutMove === 0 : payoutMove === direction;
  const oddsMoved = direction === null ? oddsTextChanged : direction !== 0;
  const fields: string[] = [];
  if (
    !isValidPotentialPayout(potentialPayout, bet.cashStake, bet.currencyDecimals) ||
    (sameLegs && !payoutFollowsOdds)
  ) {
    fields.push('potentialPayout');
  }
  if (!sameLegs) {
    fields.push('legs');
  }
  const promotionPart = promotionPotential ?? bet.promotionPotential;
  if (
    (promotionPotential !== undefined &&
      (bet.promotionType === null ||
        (sameLegs &&
          !oddsMoved &&
          (bet.promotionPotential === null ||
            !moneyEquals(promotionPotential, bet.promotionPotential))))) ||
    (promotionPart !== null &&
      !isValidPromotionPotential(promotionPart, potentialPayout, bet.currencyDecimals))
  ) {
    fields.push('promotionPotential');
  }
  return fields;
}

/** Core's own align transactions; a provider callback may not use an id under it. */
export const ALIGN_TX_PREFIX = 'core-align:';

function providerRequest<T extends TxKey>(args: T): T {
  if (!args.providerTxId.startsWith(ALIGN_TX_PREFIX)) {
    return args;
  }
  throw new LedgerRefusal('fingerprint_mismatch', {
    kind: 'fingerprint_mismatch',
    dedupeKey: `fingerprint_mismatch:${args.provider}:${args.providerTxId}`,
    provider: args.provider,
    detail: { providerTxId: args.providerTxId, reserved: true },
  });
}

function invalidAmount(
  { provider, providerTxId }: TxKey,
  detail: Record<string, unknown>,
  owner: Pick<SportsbookFindingArgs, 'betId' | 'userId'> = {},
): LedgerRefusal {
  return new LedgerRefusal('invalid_amount', {
    kind: 'invalid_amount',
    dedupeKey: `invalid_amount:${provider}:${providerTxId}`,
    provider,
    ...owner,
    detail: { providerTxId, ...detail },
  });
}

/** A promotion part is nothing on a bet with no promotion, all of a promotion-paid payout, and within its ceiling otherwise. */
export function isValidPromotionAmount(
  bet: Pick<
    SportsbookBetRow,
    'cashStake' | 'promotionType' | 'promotionPotential' | 'maxLossRefund' | 'currencyDecimals'
  >,
  result: SportsbookBetResult,
  payout: string,
  promotionAmount: string,
): boolean {
  return (
    fitsDecimals(promotionAmount, bet.currencyDecimals) &&
    (bet.promotionType !== null || !isPositiveMoney(promotionAmount)) &&
    (isPositiveMoney(bet.cashStake)
      ? moneyCompare(promotionAmount, cashPromotionCeiling(bet, result, payout)) <= 0
      : moneyEquals(promotionAmount, payout))
  );
}

async function hasWallet(tx: DrizzleTx, userId: SportsbookBetRow['userId']): Promise<boolean> {
  const [row] = await tx.select({ id: wallet.id }).from(wallet).where(eq(wallet.userId, userId));
  return row !== undefined;
}

/** A provider callback for a bet core already moved past it, or dropped: refused and filed. */
function transitionRefused(
  { provider, providerTxId }: TxKey,
  kind: SportsbookTransactionKind,
  bet: SportsbookBetRow | undefined,
): LedgerRefusal {
  return new LedgerRefusal('illegal_transition', {
    kind: 'provider_mismatch',
    dedupeKey: `provider_mismatch:${provider}:${providerTxId}`,
    provider,
    betId: bet?.id ?? null,
    userId: bet?.userId ?? null,
    detail: {
      providerTxId,
      requested: kind,
      betStatus: bet?.status ?? null,
      betVersion: bet?.version ?? null,
    },
  });
}

function isUniqueViolation(err: unknown): boolean {
  return (
    isUniqueConstraintViolation(err) ||
    (err instanceof Error && isUniqueConstraintViolation(err.cause))
  );
}

const AMOUNT_FIELDS: ReadonlySet<PropertyKey> = new Set([
  'stake',
  'potentialPayout',
  'payout',
  'promotionAmount',
  'promotionPotential',
  'legs.odds',
  'promotion.potentialAmount',
]);

const issueField = ({ path }: z.core.$ZodIssue): PropertyKey | undefined => {
  if (path[0] === 'legs' && path[2] === 'odds') {
    return 'legs.odds';
  }
  return path[0] === 'promotion' && path[1] === 'potentialAmount'
    ? 'promotion.potentialAmount'
    : path[0];
};
const RequestTxKeySchema = SportsbookConfirmArgsSchema.pick({
  provider: true,
  providerTxId: true,
  providerBetId: true,
});

/**
 * A promotion declaration core does not fully understand refuses as `promotion_not_allowed`, never
 * half-read. A malformed amount or leg odds refuse as `invalid_amount` and are filed; a malformed session id
 * refuses as `session_invalid`. Anything else malformed is the overlay's bug and throws the ZodError.
 */
function parseRequest<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }
  const fields = [...new Set(parsed.error.issues.map(issueField))];
  const refusable = (field: PropertyKey | undefined) =>
    AMOUNT_FIELDS.has(field ?? '') || field === 'sessionId' || field === 'promotion';
  if (!fields.every(refusable)) {
    throw parsed.error;
  }
  if (fields.includes('promotion')) {
    throw new LedgerRefusal('promotion_not_allowed');
  }
  if (fields.includes('sessionId')) {
    throw new LedgerRefusal('session_invalid');
  }
  const key = RequestTxKeySchema.parse(input);
  throw invalidAmount(key, { ...key, fields: fields.map(String) });
}

/** A callback's own move, apart from the `offset:` and `collect:` refs debt collections use. */
function walletRef({
  provider,
  providerTxId,
  providerBetId,
}: TxKey & BetKey): WalletCorrectionDebitArgs['providerRef'] {
  return {
    providerName: `${SPORTSBOOK_WALLET_PROVIDER_PREFIX}${provider}`,
    providerRefId: `tx:${providerTxId}`,
    externalRoundId: providerBetId,
  };
}

function applied(bet: SportsbookBetRow, balance: string): SportsbookLedgerApplied {
  return {
    status: 'applied',
    betId: bet.id,
    betStatus: bet.status,
    betVersion: bet.version,
    balance,
    currency: bet.currency,
  };
}

type BetTopic =
  | 'sportsbook.bet.placed'
  | 'sportsbook.bet.accepted'
  | 'sportsbook.bet.cancelled'
  | 'sportsbook.bet.settled'
  | 'sportsbook.bet.reopened';

function betEvent({
  bet,
  providerTxId,
  playerId,
}: {
  bet: SportsbookBetRow;
  providerTxId: SportsbookBetTransactionRow['providerTxId'];
  playerId: string | null;
}) {
  return {
    auditRecorded: true as const,
    betId: bet.id,
    userId: bet.userId,
    playerId,
    provider: bet.provider,
    providerBetId: bet.providerBetId,
    providerTxId,
    currency: bet.currency,
    version: bet.version,
  };
}

export type SportsbookLedgerDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  audit: AuditWritePort;
  config: SportsbookConfigService;
  sessions: SportsbookSessionService;
  debts: SportsbookDebtService;
  playEligibility: PlayEligibilityPort;
  identity: IdentityReader;
  wallet: WalletCommands;
  walletReader: WalletReader;
  rates?: ExchangeRateReader | undefined;
};

export class SportsbookLedgerService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly audit: AuditWritePort;
  private readonly config: SportsbookConfigService;
  private readonly sessions: SportsbookSessionService;
  private readonly debts: SportsbookDebtService;
  private readonly playEligibility: PlayEligibilityPort;
  private readonly identity: IdentityReader;
  private readonly wallet: WalletCommands;
  private readonly walletReader: WalletReader;
  private readonly rates: ExchangeRateReader | undefined;

  constructor(deps: SportsbookLedgerDeps) {
    this.drizzle = deps.drizzle;
    this.events = deps.events;
    this.audit = deps.audit;
    this.config = deps.config;
    this.sessions = deps.sessions;
    this.debts = deps.debts;
    this.playEligibility = deps.playEligibility;
    this.identity = deps.identity;
    this.wallet = deps.wallet;
    this.walletReader = deps.walletReader;
    this.rates = deps.rates;
  }

  async session(args: SportsbookSessionArgs): Promise<SportsbookSessionOutcome> {
    return this.sessions.describe(args);
  }

  async reserve(input: SportsbookReserveArgs): Promise<SportsbookLedgerOutcome> {
    return this.run(async () =>
      this.reserveOnce(providerRequest(parseRequest(SportsbookReserveArgsSchema, input))),
    );
  }

  async confirm(input: SportsbookConfirmArgs): Promise<SportsbookLedgerOutcome> {
    return this.run(async () =>
      this.confirmOnce(providerRequest(parseRequest(SportsbookConfirmArgsSchema, input))),
    );
  }

  async cancel(input: SportsbookCancelArgs): Promise<SportsbookLedgerOutcome> {
    return this.run(async () =>
      this.cancelOnce(providerRequest(parseRequest(SportsbookCancelArgsSchema, input))),
    );
  }

  async settle(input: SportsbookSettleArgs): Promise<SportsbookLedgerOutcome> {
    return this.run(async () =>
      this.settleOnce(providerRequest(parseRequest(SportsbookSettleArgsSchema, input))),
    );
  }

  async reopen(input: SportsbookReopenArgs): Promise<SportsbookLedgerOutcome> {
    return this.run(async () =>
      this.reopenOnce(providerRequest(parseRequest(SportsbookReopenArgsSchema, input))),
    );
  }

  /** A step on a bet core holds, with the caller's own write (an align audit row) last in its transaction. */
  async applyStep(step: LedgerStep, inTx: StepHook): Promise<SportsbookLedgerOutcome> {
    switch (step.kind) {
      case 'confirm':
        return this.run(async () =>
          this.confirmOnce(parseRequest(SportsbookConfirmArgsSchema, step.args), inTx),
        );
      case 'cancel':
        return this.run(async () =>
          this.cancelOnce(parseRequest(SportsbookCancelArgsSchema, step.args), inTx),
        );
      case 'settle':
        return this.run(async () =>
          this.settleOnce(parseRequest(SportsbookSettleArgsSchema, step.args), inTx),
        );
      case 'reopen':
        return this.run(async () =>
          this.reopenOnce(parseRequest(SportsbookReopenArgsSchema, step.args), inTx),
        );
    }
  }

  /** One retry on a lost race: the loser re-runs and answers from the winner's row. */
  private async run(op: () => Promise<LedgerResult>): Promise<SportsbookLedgerOutcome> {
    let result: LedgerResult;
    try {
      result = await op().catch((err: unknown) => {
        if (isUniqueViolation(err) || err instanceof LedgerRaceLost) {
          return op();
        }
        throw err;
      });
    } catch (err) {
      if (!(err instanceof LedgerRefusal)) {
        throw err;
      }
      if (err.finding) {
        await fileFinding(this.drizzle.db, err.finding);
      }
      return { status: 'refused', reason: err.reason };
    }
    return result.outcome;
  }

  private transaction(
    db: DrizzleDb,
    body: (tx: DrizzleTx) => Promise<LedgerResult>,
  ): Promise<LedgerResult> {
    return db.transaction(async (tx) => {
      const result = await body(tx);
      const { userId, moves = [], announce, debt } = result;
      if (userId) {
        const playerId = await this.identity.getPlayerIdByUserId(userId, tx);
        for (const move of moves) {
          await this.events.emitInTransaction(tx, 'wallet.balance.changed', {
            userId,
            playerId,
            ...move,
          });
        }
        await announce?.(playerId);
        if (debt) {
          await this.debts.announce(tx, debt);
        }
      }
      return result;
    });
  }

  /** The bet event to the outbox, and its audit row unless an align step wrote its own. */
  private async announceBet<K extends BetTopic>(
    tx: DrizzleTx,
    topic: K,
    payload: DomainEventPayload<K>,
    step: StepHook | undefined,
  ): Promise<void> {
    await this.events.emitInTransaction(tx, topic, payload);
    if (!step) {
      await this.audit.recordInTransaction(tx, {
        actorType: 'player',
        actorId: payload.playerId,
        action: topic,
        resourceType: 'sportsbook_bet',
        resourceId: payload.betId,
        after: payload,
      });
    }
  }

  /**
   * The stake currency's USD rate, read before the reserve transaction, which makes no network
   * call. `null` when the cap cannot be checked: no usable rate, or a cap set after the read
   * below. Never read without a cap.
   */
  private async promotionUsdRate(args: ReserveArgs): Promise<string | null> {
    if (args.promotion?.stake !== 'promotion') {
      return null;
    }
    const { promotions } = await this.config.get();
    if (promotions.maxPromotionStakeUsd === null) {
      return null;
    }
    const quote = this.rates ? await this.rates.getRate(args.currency, 'USD') : null;
    if (!quote || !isPositiveMoney(quote.rate)) {
      logger.warn(
        { currency: args.currency, providerBetId: args.providerBetId },
        'sportsbook: no USD rate for a promotion-paid stake, refusing it under the cap',
      );
      return null;
    }
    return quote.rate;
  }

  private async reserveOnce(args: ReserveArgs): Promise<LedgerResult> {
    const db = this.drizzle.db;
    const [session] = await db
      .select()
      .from(sportsbookSession)
      .where(eq(sportsbookSession.id, args.sessionId));
    const fingerprint = requestFingerprint({
      kind: 'reserve',
      provider: args.provider,
      providerBetId: args.providerBetId,
      userId: session?.userId ?? null,
      amount: args.stake,
      currency: args.currency,
      potentialPayout: args.potentialPayout,
      legs: args.legs,
      promotion: args.promotion,
    });
    const stored = await this.findStored(db, args);
    if (stored) {
      return this.answerStored(stored, fingerprint, 'reserve');
    }
    if (!session) {
      throw new LedgerRefusal('session_invalid');
    }
    const userId = session.userId;
    const promotionUsdRate = await this.promotionUsdRate(args);

    return this.transaction(db, async (tx) => {
      await lockConfig(tx, 'shared');
      await lockPlayer(tx, userId);
      const again = await this.findStored(tx, args);
      if (again) {
        return this.answerStored(again, fingerprint, 'reserve');
      }
      const existing = await this.findBet(tx, args);
      if (existing) {
        throw transitionRefused(args, 'reserve', existing);
      }
      if (await this.hasOrigin(tx, args)) {
        throw new LedgerRefusal('illegal_transition');
      }
      const config = await this.config.get(tx);
      const offered = config.currencies.find((c) => c.currency === args.currency);
      if (!config.enabled || config.suspended) {
        throw new LedgerRefusal('suspended');
      }
      if (!offered) {
        throw new LedgerRefusal('currency_not_offered');
      }
      const [live] = await tx
        .select()
        .from(sportsbookSession)
        .where(eq(sportsbookSession.id, args.sessionId));
      if (
        !isLiveSession(live, args.provider) ||
        live.currency !== args.currency ||
        config.blockedCountries.includes(live.countryCode)
      ) {
        throw new LedgerRefusal('session_invalid');
      }
      if (
        !isPositiveMoney(args.stake) ||
        !fitsDecimals(args.stake, offered.decimals) ||
        !isValidPotentialPayout(
          args.potentialPayout,
          resolveStake(args.stake, args.promotion).cashStake,
          offered.decimals,
        ) ||
        (args.promotion?.potentialAmount !== undefined &&
          !isValidPromotionPotential(
            args.promotion.potentialAmount,
            args.potentialPayout,
            offered.decimals,
          ))
      ) {
        throw invalidAmount(
          args,
          {
            providerBetId: args.providerBetId,
            currency: args.currency,
            stake: args.stake,
            potentialPayout: args.potentialPayout,
            potentialAmount: args.promotion?.potentialAmount ?? null,
            decimals: offered.decimals,
          },
          { userId },
        );
      }
      const { promotion } = args;
      const promotionCap = config.promotions.maxPromotionStakeUsd;
      if (
        promotion &&
        (!config.promotions.enabled ||
          (promotion.stake === 'promotion' &&
            promotionCap !== null &&
            // Compared in the stake's currency: flooring the cap there is exact on the stake's grid.
            (promotionUsdRate === null ||
              moneyCompare(args.stake, moneyDivide(promotionCap, promotionUsdRate)) > 0)))
      ) {
        throw new LedgerRefusal('promotion_not_allowed');
      }
      // The only eligibility gate for a promotion-paid stake: no wallet debit runs to re-check it.
      const refusal = await playRefusal(this.playEligibility, userId, tx);
      if (refusal) {
        throw new LedgerRefusal(refusal);
      }
      if (await isPlayerRestricted(tx, userId)) {
        throw new LedgerRefusal('sportsbook_restricted');
      }

      const lastLegStartsAt = new Date(
        Math.max(...args.legs.map((leg) => new Date(leg.startsAt).getTime())),
      );
      const bet = findOneOrThrow(
        await tx
          .insert(sportsbookBet)
          .values({
            userId,
            provider: args.provider,
            providerBetId: args.providerBetId,
            sessionId: live.id,
            currency: args.currency,
            currencyDecimals: offered.decimals,
            status: 'reserved',
            stake: args.stake,
            ...resolveStake(args.stake, promotion),
            promotionType: promotion?.type ?? null,
            promotionId: promotion?.id ?? null,
            promotionFunder: promotion ? promotionFunder(config.promotions, promotion.type) : null,
            promotionPotential: promotion?.potentialAmount ?? null,
            potentialPayout: args.potentialPayout,
            legs: args.legs,
            lastLegStartsAt,
          })
          .returning(),
        new Error('sportsbook reserve: bet insert returned no row'),
      );

      // Without a debit nothing else proves the wallet a later settle credits exists.
      if (!isPositiveMoney(bet.cashStake) && !(await hasWallet(tx, userId))) {
        throw new LedgerRefusal('insufficient_funds');
      }
      const debit = isPositiveMoney(bet.cashStake) ? await this.debitStake(tx, bet, args) : null;
      const balance = debit ? debit.newBalance : await this.balanceOf(tx, bet);

      await tx.insert(sportsbookBetTransaction).values({
        provider: args.provider,
        providerTxId: args.providerTxId,
        providerBetId: args.providerBetId,
        betId: bet.id,
        userId,
        kind: 'reserve',
        amount: bet.cashStake,
        potentialPayout: args.potentialPayout,
        legs: args.legs,
        promotionPotential: bet.promotionPotential,
        betVersion: bet.version,
        fingerprint,
        walletTransactionIds: debit ? [debit.transactionId] : [],
        balanceAfter: balance,
        currency: bet.currency,
      });

      const moves: WalletMove[] = debit
        ? [
            {
              transactionId: debit.transactionId,
              amount: bet.cashStake,
              currency: bet.currency,
              type: 'bet',
              direction: 'debit',
            },
            ...(debit.wagerTrackingCredits ?? []).map(
              (credit): WalletMove => ({ ...credit, type: 'cashback', direction: 'credit' }),
            ),
          ]
        : [];
      return {
        outcome: applied(bet, balance),
        userId,
        moves,
        announce: (playerId) =>
          this.announceBet(
            tx,
            'sportsbook.bet.placed',
            {
              ...betEvent({ bet: bet, providerTxId: args.providerTxId, playerId }),
              stake: bet.stake,
              ...(promotion ? { promotion } : {}),
            },
            undefined,
          ),
      };
    });
  }

  private async debitStake(tx: DrizzleTx, bet: SportsbookBetRow, args: ReserveArgs) {
    let debit;
    try {
      debit = await this.wallet.debit(tx, {
        userId: bet.userId,
        amount: bet.cashStake,
        type: 'bet',
        currency: bet.currency,
        providerRef: walletRef(args),
        context: { provider: args.provider, product: 'sportsbook' },
      });
    } catch (err) {
      if (err instanceof RgLimitExceededError) {
        throw new LedgerRefusal('limit');
      }
      throw err;
    }
    if (!debit.ok) {
      throw new LedgerRefusal('insufficient_funds');
    }
    if (!debit.moved) {
      throw new LedgerRaceLost('a stake');
    }
    return debit;
  }

  private async confirmOnce(args: ConfirmArgs, step?: StepHook): Promise<LedgerResult> {
    const db = this.drizzle.db;
    const bet = await this.findBet(db, args);
    const fingerprint = requestFingerprint({
      kind: 'confirm',
      provider: args.provider,
      providerBetId: args.providerBetId,
      userId: bet?.userId ?? null,
      potentialPayout: args.potentialPayout,
      legs: args.legs,
      promotionPotential: args.promotionPotential,
    });
    const stored = await this.findStored(db, args);
    if (stored) {
      return this.answerStored(stored, fingerprint, 'confirm');
    }
    if (!bet) {
      throw (await this.hasOrigin(db, args))
        ? transitionRefused(args, 'confirm', undefined)
        : new LedgerRefusal('bet_not_found');
    }

    return this.transaction(db, async (tx) => {
      await lockPlayer(tx, bet.userId);
      const again = await this.findStored(tx, args);
      if (again) {
        return this.answerStored(again, fingerprint, 'confirm');
      }
      const [current] = await tx.select().from(sportsbookBet).where(eq(sportsbookBet.id, bet.id));
      if (current?.status !== 'reserved') {
        throw transitionRefused(args, 'confirm', current ?? bet);
      }
      const invalid = invalidTerms(current, args);
      if (invalid.length > 0) {
        throw invalidAmount(
          args,
          {
            providerBetId: args.providerBetId,
            fields: invalid,
            stake: current.stake,
            potentialPayout: args.potentialPayout ?? null,
            promotionPotential: args.promotionPotential ?? null,
            decimals: current.currencyDecimals,
          },
          { betId: current.id, userId: current.userId },
        );
      }
      const [accepted] = await tx
        .update(sportsbookBet)
        .set({
          status: 'accepted',
          acceptedAt: new Date(),
          ...(args.potentialPayout === undefined ? {} : { potentialPayout: args.potentialPayout }),
          ...(args.legs === undefined ? {} : { legs: args.legs }),
          ...(args.promotionPotential === undefined
            ? {}
            : { promotionPotential: args.promotionPotential }),
        })
        .where(and(eq(sportsbookBet.id, current.id), eq(sportsbookBet.status, 'reserved')))
        .returning();
      if (!accepted) {
        throw transitionRefused(args, 'confirm', current);
      }
      const balance = await this.balanceOf(tx, accepted);
      await tx.insert(sportsbookBetTransaction).values({
        provider: args.provider,
        providerTxId: args.providerTxId,
        providerBetId: args.providerBetId,
        betId: accepted.id,
        userId: accepted.userId,
        kind: 'confirm',
        potentialPayout: args.potentialPayout ?? null,
        legs: args.legs ?? null,
        promotionPotential: args.promotionPotential ?? null,
        betVersion: accepted.version,
        fingerprint,
        balanceAfter: balance,
        currency: accepted.currency,
      });
      await step?.(tx, accepted);
      return {
        outcome: applied(accepted, balance),
        userId: accepted.userId,
        announce: (playerId) =>
          this.announceBet(
            tx,
            'sportsbook.bet.accepted',
            {
              ...betEvent({ bet: accepted, providerTxId: args.providerTxId, playerId }),
              potentialPayout: accepted.potentialPayout,
              ...(args.legs === undefined ? {} : { legs: args.legs }),
              ...(args.promotionPotential === undefined
                ? {}
                : { promotionPotential: args.promotionPotential }),
            },
            step,
          ),
      };
    });
  }

  private async cancelOnce(args: CancelArgs, step?: StepHook): Promise<LedgerResult> {
    const bet = await this.findBet(this.drizzle.db, args);
    if (bet) {
      return this.cancelKnown(args, bet, step);
    }
    const tombstoned = await this.cancelUnknown(args);
    if (tombstoned !== 'bet_appeared') {
      return tombstoned;
    }
    const appeared = await this.findBet(this.drizzle.db, args);
    if (!appeared) {
      throw new Error('sportsbook cancel: a bet seen under its lock is gone');
    }
    return this.cancelKnown(args, appeared, step);
  }

  private async cancelKnown(
    args: CancelArgs,
    bet: SportsbookBetRow,
    step?: StepHook,
  ): Promise<LedgerResult> {
    const db = this.drizzle.db;
    const fingerprint = requestFingerprint({
      kind: 'cancel',
      provider: args.provider,
      providerBetId: args.providerBetId,
      userId: bet.userId,
      cancelReason: args.reason,
    });
    const stored = await this.findStored(db, args);
    if (stored) {
      return this.answerStored(stored, fingerprint, 'cancel');
    }

    return this.transaction(db, async (tx) => {
      await lockPlayer(tx, bet.userId);
      const again = await this.findStored(tx, args);
      if (again) {
        return this.answerStored(again, fingerprint, 'cancel');
      }
      const [cancelled] = await tx
        .update(sportsbookBet)
        .set({ status: 'cancelled', cancelledAt: new Date() })
        .where(and(eq(sportsbookBet.id, bet.id), eq(sportsbookBet.status, 'reserved')))
        .returning();
      if (!cancelled) {
        throw transitionRefused(args, 'cancel', bet);
      }
      const refunded = cancelled.cashStake;
      const moves: WalletMove[] = [];
      let balance: string;
      if (isPositiveMoney(refunded)) {
        const credit = await this.wallet.credit(tx, {
          userId: cancelled.userId,
          amount: refunded,
          currency: cancelled.currency,
          type: 'bet_reversal',
          allowNewCurrency: true,
          providerRef: walletRef(args),
        });
        if (!credit.ok) {
          throw new Error(`sportsbook cancel: stake refund did not move (${credit.reason})`);
        }
        if (!credit.moved) {
          throw new LedgerRaceLost('a stake refund');
        }
        moves.push({
          transactionId: credit.transactionId,
          amount: refunded,
          currency: cancelled.currency,
          type: 'bet_reversal',
          direction: 'credit',
        });
        balance = credit.newBalance;
      } else {
        balance = await this.balanceOf(tx, cancelled);
      }
      await tx.insert(sportsbookBetTransaction).values({
        provider: args.provider,
        providerTxId: args.providerTxId,
        providerBetId: args.providerBetId,
        betId: cancelled.id,
        userId: cancelled.userId,
        kind: 'cancel',
        amount: refunded,
        betVersion: cancelled.version,
        fingerprint,
        cancelReason: args.reason,
        walletTransactionIds: moves.map((m) => m.transactionId),
        balanceAfter: balance,
        currency: cancelled.currency,
      });
      await step?.(tx, cancelled);
      return {
        outcome: applied(cancelled, balance),
        userId: cancelled.userId,
        moves,
        announce: (playerId) =>
          this.announceBet(
            tx,
            'sportsbook.bet.cancelled',
            {
              ...betEvent({ bet: cancelled, providerTxId: args.providerTxId, playerId }),
              reason: args.reason,
              refunded,
            },
            step,
          ),
      };
    });
  }

  /** A cancel for a bet core never saw: a tombstone under the bet key, so a late reserve refuses. */
  private async cancelUnknown(args: CancelArgs): Promise<LedgerResult | 'bet_appeared'> {
    const db = this.drizzle.db;
    const fingerprint = requestFingerprint({
      kind: 'cancel',
      provider: args.provider,
      providerBetId: args.providerBetId,
      userId: null,
      cancelReason: args.reason,
    });
    const stored = await this.findStored(db, args);
    if (stored) {
      return this.answerStored(stored, fingerprint, 'cancel');
    }

    return db.transaction(async (tx) => {
      await lockBet(tx, args.provider, args.providerBetId);
      const again = await this.findStored(tx, args);
      if (again) {
        return this.answerStored(again, fingerprint, 'cancel');
      }
      // A reserve committed since the unlocked read; start over under its lock order.
      if (await this.findBet(tx, args)) {
        return 'bet_appeared';
      }
      if (await this.hasOrigin(tx, args)) {
        throw transitionRefused(args, 'cancel', undefined);
      }
      await tx.insert(sportsbookBetTransaction).values({
        provider: args.provider,
        providerTxId: args.providerTxId,
        providerBetId: args.providerBetId,
        kind: 'cancel',
        fingerprint,
        cancelReason: args.reason,
      });
      return {
        outcome: {
          status: 'applied',
          betId: null,
          betStatus: null,
          betVersion: null,
          balance: null,
          currency: null,
        },
      };
    });
  }

  private async settleOnce(args: SettleArgs, step?: StepHook): Promise<LedgerResult> {
    const db = this.drizzle.db;
    const bet = await this.findBet(db, args);
    const fingerprint = requestFingerprint({
      kind: 'settle',
      provider: args.provider,
      providerBetId: args.providerBetId,
      userId: bet?.userId ?? null,
      amount: args.payout,
      result: args.result,
      version: args.expectedVersion,
      promotionAmount: args.promotionAmount,
    });
    const stored = await this.findStored(db, args);
    if (stored) {
      return this.answerStored(stored, fingerprint, 'settle');
    }
    if (!bet) {
      throw (await this.hasOrigin(db, args))
        ? transitionRefused(args, 'settle', undefined)
        : new LedgerRefusal('bet_not_found');
    }

    return this.transaction(db, async (tx) => {
      await lockPlayer(tx, bet.userId);
      const again = await this.findStored(tx, args);
      if (again) {
        return this.answerStored(again, fingerprint, 'settle');
      }
      const current = await this.openVersion(tx, { bet, status: 'accepted', args, kind: 'settle' });
      const { payout, result } = args;
      const promotionAmount =
        args.promotionAmount ?? defaultPromotionAmount(current, result, payout);
      if (
        !isValidSettlement(current, result, payout) ||
        !isValidPromotionAmount(current, result, payout, promotionAmount)
      ) {
        throw invalidAmount(
          args,
          { result, payout, promotionAmount, decimals: current.currencyDecimals },
          { betId: current.id, userId: current.userId },
        );
      }
      if (moneyCompare(payout, current.potentialPayout) > 0) {
        await fileFinding(tx, {
          kind: 'payout_above_potential',
          dedupeKey: `payout_above_potential:${args.provider}:${args.providerTxId}`,
          provider: args.provider,
          betId: current.id,
          userId: current.userId,
          detail: {
            providerTxId: args.providerTxId,
            payout,
            potentialPayout: current.potentialPayout,
          },
        });
      }
      if (isUnusualPromotionPayout(current, payout)) {
        await fileFinding(tx, {
          kind: 'promotion_payout_unusual',
          dedupeKey: `promotion_payout_unusual:${args.provider}:${args.providerTxId}`,
          provider: args.provider,
          betId: current.id,
          userId: current.userId,
          detail: {
            providerTxId: args.providerTxId,
            payout,
            stake: current.stake,
            odds: current.legs.map((leg) => leg.odds ?? null),
          },
        });
      }
      const pays = isPositiveMoney(payout);
      // Only a stake the player paid comes back as a reversal; a promotion's void return is a win.
      const creditType: WalletTransactionType =
        result === 'void' && isPositiveMoney(current.cashStake) ? 'bet_reversal' : 'win';
      const debt =
        pays && creditType === 'win' ? await this.debts.lockOutstanding(tx, current) : undefined;

      const [settled] = await tx
        .update(sportsbookBet)
        .set({
          status: 'settled',
          result,
          payoutTotal: payout,
          promotionPaid: promotionAmount,
          settledAt: new Date(),
        })
        .where(
          and(
            eq(sportsbookBet.id, current.id),
            eq(sportsbookBet.status, 'accepted'),
            eq(sportsbookBet.version, current.version),
          ),
        )
        .returning();
      if (!settled) {
        throw transitionRefused(args, 'settle', current);
      }

      const moves: WalletMove[] = [];
      let balance: string;
      let debtChange: DebtChange | undefined;
      if (pays) {
        const credit = await this.wallet.credit(tx, {
          userId: settled.userId,
          amount: payout,
          currency: settled.currency,
          type: creditType,
          allowNewCurrency: true,
          providerRef: walletRef(args),
        });
        if (!credit.ok) {
          throw new Error(`sportsbook settle: payout did not move (${credit.reason})`);
        }
        if (!credit.moved) {
          throw new LedgerRaceLost('a payout');
        }
        moves.push({
          transactionId: credit.transactionId,
          amount: payout,
          currency: settled.currency,
          type: creditType,
          direction: 'credit',
        });
        balance = credit.newBalance;
        const offset = debt
          ? await this.debts.offset(tx, debt, {
              provider: args.provider,
              payout,
              providerTxId: args.providerTxId,
            })
          : null;
        if (offset) {
          moves.push(
            ...offset.moves.map((move) => ({
              ...move,
              currency: settled.currency,
              direction: 'debit' as const,
            })),
          );
          balance = offset.newBalance;
          debtChange = offset.change;
        }
      } else {
        balance = await this.balanceOf(tx, settled);
      }

      await tx.insert(sportsbookBetTransaction).values({
        provider: args.provider,
        providerTxId: args.providerTxId,
        providerBetId: args.providerBetId,
        betId: settled.id,
        userId: settled.userId,
        kind: 'settle',
        amount: payout,
        promotionAmount,
        betVersion: settled.version,
        fingerprint,
        result,
        walletTransactionIds: moves.map((m) => m.transactionId),
        balanceAfter: balance,
        currency: settled.currency,
      });
      if (debtChange) {
        await this.debts.writeAudit(tx, debtChange);
      }
      await step?.(tx, settled);
      return {
        outcome: applied(settled, balance),
        userId: settled.userId,
        moves,
        debt: debtChange,
        announce: (playerId) =>
          this.announceBet(
            tx,
            'sportsbook.bet.settled',
            {
              ...betEvent({ bet: settled, providerTxId: args.providerTxId, playerId }),
              result,
              payout,
              promotionAmount,
            },
            step,
          ),
      };
    });
  }

  private async reopenOnce(args: ReopenArgs, step?: StepHook): Promise<LedgerResult> {
    const db = this.drizzle.db;
    const bet = await this.findBet(db, args);
    const fingerprint = requestFingerprint({
      kind: 'reopen',
      provider: args.provider,
      providerBetId: args.providerBetId,
      userId: bet?.userId ?? null,
      version: args.expectedVersion,
    });
    const stored = await this.findStored(db, args);
    if (stored) {
      return this.answerStored(stored, fingerprint, 'reopen');
    }
    if (!bet) {
      throw (await this.hasOrigin(db, args))
        ? transitionRefused(args, 'reopen', undefined)
        : new LedgerRefusal('bet_not_found');
    }

    return this.transaction(db, async (tx) => {
      await lockPlayer(tx, bet.userId);
      const again = await this.findStored(tx, args);
      if (again) {
        return this.answerStored(again, fingerprint, 'reopen');
      }
      const current = await this.openVersion(tx, { bet, status: 'settled', args, kind: 'reopen' });
      const [reopened] = await tx
        .update(sportsbookBet)
        .set({
          status: 'accepted',
          version: current.version + 1,
          result: null,
          payoutTotal: '0',
          promotionPaid: '0',
          settledAt: null,
        })
        .where(
          and(
            eq(sportsbookBet.id, current.id),
            eq(sportsbookBet.status, 'settled'),
            eq(sportsbookBet.version, current.version),
          ),
        )
        .returning();
      if (!reopened) {
        throw transitionRefused(args, 'reopen', current);
      }

      const moves: WalletMove[] = [];
      let collected = '0';
      let shortfall = '0';
      let balance: string;
      let debtChange: DebtChange | undefined;
      if (isPositiveMoney(current.payoutTotal)) {
        // A void of a player-paid stake was a reversal, so the reopen re-stakes it; any other payout was a win.
        const type =
          current.result === 'void' && isPositiveMoney(current.cashStake) ? 'bet' : 'win_reversal';
        const correction = await this.wallet
          .correctionDebit(tx, {
            userId: current.userId,
            amount: current.payoutTotal,
            currency: current.currency,
            type,
            providerRef: walletRef(args),
          })
          .catch((err: unknown) => {
            if (err instanceof WalletCorrectionRefConflictError) {
              throw new LedgerRaceLost('a correction');
            }
            if (err instanceof WalletCorrectionExceedsRoundError) {
              throw invalidAmount(
                args,
                { reversed: current.payoutTotal, available: err.available, type },
                { betId: current.id, userId: current.userId },
              );
            }
            throw err;
          });
        if (!correction.moved && moneyCompare(correction.collected, '0') > 0) {
          throw new LedgerRaceLost('a correction');
        }
        ({ collected, shortfall } = correction);
        balance = correction.newBalance;
        if (correction.moved) {
          moves.push({
            transactionId: correction.transactionId,
            amount: collected,
            currency: current.currency,
            type,
            direction: 'debit',
          });
        }
        if (isPositiveMoney(shortfall)) {
          debtChange = await this.debts.record(tx, {
            userId: current.userId,
            currency: current.currency,
            shortfall,
            betId: current.id,
            type,
            finding: {
              kind: 'debt_recorded',
              dedupeKey: `debt_recorded:${args.provider}:${args.providerTxId}`,
              provider: args.provider,
              betId: current.id,
              userId: current.userId,
              detail: {
                providerTxId: args.providerTxId,
                reversed: current.payoutTotal,
                collected,
                shortfall,
              },
            },
          });
        }
      } else {
        balance = await this.balanceOf(tx, reopened);
      }

      await tx.insert(sportsbookBetTransaction).values({
        provider: args.provider,
        providerTxId: args.providerTxId,
        providerBetId: args.providerBetId,
        betId: reopened.id,
        userId: reopened.userId,
        kind: 'reopen',
        amount: collected,
        promotionAmount: current.promotionPaid,
        betVersion: reopened.version,
        fingerprint,
        walletTransactionIds: moves.map((m) => m.transactionId),
        balanceAfter: balance,
        currency: reopened.currency,
      });
      if (debtChange) {
        await this.debts.writeAudit(tx, debtChange);
      }
      await step?.(tx, reopened);
      return {
        outcome: applied(reopened, balance),
        userId: reopened.userId,
        moves,
        debt: debtChange,
        announce: (playerId) =>
          this.announceBet(
            tx,
            'sportsbook.bet.reopened',
            {
              ...betEvent({ bet: reopened, providerTxId: args.providerTxId, playerId }),
              collected,
              shortfall,
            },
            step,
          ),
      };
    });
  }

  /** The bet re-read under the player lock, in the status and at the version the step expects. */
  private async openVersion(
    tx: DrizzleTx,
    {
      bet,
      status,
      args,
      kind,
    }: {
      bet: SportsbookBetRow;
      status: SportsbookBetStatus;
      args: (SettleArgs | ReopenArgs) & TxKey;
      kind: SportsbookTransactionKind;
    },
  ): Promise<SportsbookBetRow> {
    const [current] = await tx.select().from(sportsbookBet).where(eq(sportsbookBet.id, bet.id));
    if (
      !current ||
      current.status !== status ||
      (args.expectedVersion !== undefined && current.version !== args.expectedVersion)
    ) {
      throw transitionRefused(args, kind, current ?? bet);
    }
    return current;
  }

  private async findStored(
    db: DrizzleDb | DrizzleTx,
    { provider, providerTxId }: TxKey,
  ): Promise<SportsbookBetTransactionRow | undefined> {
    const [row] = await db
      .select()
      .from(sportsbookBetTransaction)
      .where(
        and(
          eq(sportsbookBetTransaction.provider, provider),
          eq(sportsbookBetTransaction.providerTxId, providerTxId),
        ),
      );
    return row;
  }

  private async findBet(
    db: DrizzleDb | DrizzleTx,
    { provider, providerBetId }: BetKey,
  ): Promise<SportsbookBetRow | undefined> {
    const [row] = await db
      .select()
      .from(sportsbookBet)
      .where(
        and(eq(sportsbookBet.provider, provider), eq(sportsbookBet.providerBetId, providerBetId)),
      );
    return row;
  }

  /** A reserve or a tombstone already claimed this provider bet id. */
  private async hasOrigin(
    db: DrizzleDb | DrizzleTx,
    { provider, providerBetId }: BetKey,
  ): Promise<boolean> {
    const rows = await db
      .select({ id: sportsbookBetTransaction.id })
      .from(sportsbookBetTransaction)
      .where(
        and(
          eq(sportsbookBetTransaction.provider, provider),
          eq(sportsbookBetTransaction.providerBetId, providerBetId),
          or(eq(sportsbookBetTransaction.kind, 'reserve'), isNull(sportsbookBetTransaction.betId)),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  private answerStored(
    stored: SportsbookBetTransactionRow,
    fingerprint: string,
    kind: SportsbookTransactionKind,
  ): LedgerResult {
    if (stored.fingerprint !== fingerprint) {
      throw new LedgerRefusal('fingerprint_mismatch', {
        kind: 'fingerprint_mismatch',
        dedupeKey: `fingerprint_mismatch:${stored.provider}:${stored.providerTxId}`,
        provider: stored.provider,
        betId: stored.betId,
        userId: stored.userId,
        detail: { providerTxId: stored.providerTxId, storedKind: stored.kind, requestedKind: kind },
      });
    }
    return {
      outcome: {
        status: 'replayed',
        betId: stored.betId,
        betStatus: stored.betId ? STATUS_AFTER[stored.kind] : null,
        betVersion: stored.betId ? stored.betVersion : null,
        balance: stored.balanceAfter,
        currency: stored.currency,
      },
    };
  }

  private async balanceOf(tx: DrizzleTx, bet: SportsbookBetRow): Promise<string> {
    const { balances } = await this.walletReader.getBalances(bet.userId, tx);
    return balances.find((b) => b.currency === bet.currency)?.balance ?? '0';
  }
}
