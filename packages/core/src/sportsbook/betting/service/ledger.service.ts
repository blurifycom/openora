import { createHash } from 'node:crypto';
import { and, eq, isNull, or } from 'drizzle-orm';
import {
  findOneOrThrow,
  isPositiveMoney,
  isUniqueConstraintViolation,
  moneyCompare,
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
  type IdentityReader,
  type PlayEligibilityPort,
  type SportsbookBetLeg,
  type SportsbookBetResult,
  type SportsbookBetStatus,
  type SportsbookCancelArgs,
  type SportsbookConfirmArgs,
  type SportsbookLedgerApplied,
  type SportsbookLedgerOutcome,
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
  type SportsbookTransactionKind,
} from '../contract/index.js';
import {
  sportsbookBet,
  sportsbookBetTransaction,
  sportsbookSession,
  type SportsbookBetRow,
  type SportsbookBetTransactionRow,
} from '../schema/index.js';
import type { SportsbookConfigService } from './config.service.js';
import type { DebtChange, SportsbookDebtService } from './debt.service.js';
import { fileFinding, type SportsbookFindingArgs } from './finding.service.js';
import { lockBet, lockConfig, lockPlayer } from './locks.service.js';
import { isPlayerRestricted } from './restriction-check.service.js';
import { isLiveSession, type SportsbookSessionService } from './session.service.js';

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

function requestFingerprint(parts: FingerprintParts): string {
  const canonical = JSON.stringify([
    parts.kind,
    parts.provider,
    parts.providerBetId,
    parts.userId ?? '',
    parts.amount === undefined ? '' : moneyFloorToScale(parts.amount, MONEY_SCALE),
    parts.potentialPayout === undefined
      ? ''
      : moneyFloorToScale(parts.potentialPayout, MONEY_SCALE),
    parts.currency ?? '',
    parts.result ?? '',
    parts.cancelReason ?? '',
    parts.version ?? '',
    parts.legs?.map((leg) => [legIdentity(leg), leg.odds ?? null]) ?? '',
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

function fitsDecimals(amount: string, decimals: number): boolean {
  return moneyEquals(moneyFloorToScale(amount, decimals), amount);
}

/** Decimals fit the currency, a void returns exactly the stake, and a loss pays nothing. */
export function isValidSettlement(
  bet: Pick<SportsbookBetRow, 'stake' | 'currencyDecimals'>,
  result: SportsbookBetResult,
  payout: string,
): boolean {
  return (
    fitsDecimals(payout, bet.currencyDecimals) &&
    (result !== 'void' || moneyEquals(payout, bet.stake)) &&
    (result !== 'lost' || !isPositiveMoney(payout))
  );
}

/** Fits the currency's decimals and pays back at least the stake. */
function isValidPotentialPayout(payout: string, stake: string, decimals: number): boolean {
  return fitsDecimals(payout, decimals) && moneyCompare(payout, stake) >= 0;
}

const DECIMAL_ODDS = /^\d+(?:\.\d+)?$/;

/**
 * How the accepted odds move the combined odds of the legs that carry them: -1, 0 or 1. Null when
 * an odds is not a decimal, so its direction is unknown.
 */
function oddsDirection(reserved: SportsbookBetLeg[], accepted: SportsbookBetLeg[]): number | null {
  let before = { digits: 1n, scale: 0 };
  let after = { digits: 1n, scale: 0 };
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
  const scale = Math.max(before.scale, after.scale);
  const left = after.digits * 10n ** BigInt(scale - after.scale);
  const right = before.digits * 10n ** BigInt(scale - before.scale);
  return left === right ? 0 : left > right ? 1 : -1;
}

/** Exact, untruncated: `digits / 10^scale` times a decimal string. */
function timesDecimal(
  product: { digits: bigint; scale: number },
  decimal: string,
): { digits: bigint; scale: number } {
  const [whole, fraction = ''] = decimal.split('.');
  return {
    digits: product.digits * BigInt(`${whole}${fraction}`),
    scale: product.scale + fraction.length,
  };
}

/**
 * The fields of accepted terms that do not fit the reserved bet. The terms come as a pair, the legs
 * may change only their odds, and the payout moves with the combined odds: up when they rise, down
 * when they fall, not at all when they hold. Odds that are not decimals only let the payout change.
 */
function invalidTerms(
  bet: Pick<SportsbookBetRow, 'stake' | 'potentialPayout' | 'currencyDecimals' | 'legs'>,
  { potentialPayout, legs }: Pick<ConfirmArgs, 'potentialPayout' | 'legs'>,
): string[] {
  if (potentialPayout === undefined && legs === undefined) {
    return [];
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
  const fields: string[] = [];
  if (
    !isValidPotentialPayout(potentialPayout, bet.stake, bet.currencyDecimals) ||
    (sameLegs && !payoutFollowsOdds)
  ) {
    fields.push('potentialPayout');
  }
  if (!sameLegs) {
    fields.push('legs');
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

const AMOUNT_FIELDS: ReadonlySet<PropertyKey> = new Set(['stake', 'potentialPayout', 'payout']);
const RequestTxKeySchema = SportsbookConfirmArgsSchema.pick({
  provider: true,
  providerTxId: true,
  providerBetId: true,
});

/**
 * A malformed amount refuses as `invalid_amount` and is filed; a malformed session id refuses as
 * `session_invalid`. Anything else malformed is the overlay's bug and throws the ZodError.
 */
function parseRequest<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }
  const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0]))];
  if (!fields.every((field) => AMOUNT_FIELDS.has(field ?? '') || field === 'sessionId')) {
    throw parsed.error;
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
    });
    const stored = await this.findStored(db, args);
    if (stored) {
      return this.answerStored(stored, fingerprint, 'reserve');
    }
    if (!session) {
      throw new LedgerRefusal('session_invalid');
    }
    const userId = session.userId;

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
      if (!config.enabled || config.suspended || !offered) {
        throw new LedgerRefusal('suspended');
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
        !isValidPotentialPayout(args.potentialPayout, args.stake, offered.decimals)
      ) {
        throw invalidAmount(
          args,
          {
            providerBetId: args.providerBetId,
            stake: args.stake,
            potentialPayout: args.potentialPayout,
            decimals: offered.decimals,
          },
          { userId },
        );
      }
      if (
        (await isPlayerRestricted(tx, userId)) ||
        (await this.playEligibility.isRestricted(userId, tx))
      ) {
        throw new LedgerRefusal('player_blocked');
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
            potentialPayout: args.potentialPayout,
            legs: args.legs,
            lastLegStartsAt,
          })
          .returning(),
        new Error('sportsbook reserve: bet insert returned no row'),
      );

      let debit;
      try {
        debit = await this.wallet.debit(tx, {
          userId,
          amount: args.stake,
          type: 'bet',
          currency: args.currency,
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

      await tx.insert(sportsbookBetTransaction).values({
        provider: args.provider,
        providerTxId: args.providerTxId,
        providerBetId: args.providerBetId,
        betId: bet.id,
        userId,
        kind: 'reserve',
        amount: args.stake,
        potentialPayout: args.potentialPayout,
        legs: args.legs,
        betVersion: bet.version,
        fingerprint,
        walletTransactionIds: [debit.transactionId],
        balanceAfter: debit.newBalance,
        currency: bet.currency,
      });

      const moves: WalletMove[] = [
        {
          transactionId: debit.transactionId,
          amount: args.stake,
          currency: bet.currency,
          type: 'bet',
          direction: 'debit',
        },
        ...(debit.wagerTrackingCredits ?? []).map(
          (credit): WalletMove => ({ ...credit, type: 'cashback', direction: 'credit' }),
        ),
      ];
      return {
        outcome: applied(bet, debit.newBalance),
        userId,
        moves,
        announce: (playerId) =>
          this.announceBet(
            tx,
            'sportsbook.bet.placed',
            {
              ...betEvent({ bet: bet, providerTxId: args.providerTxId, playerId }),
              stake: bet.stake,
            },
            undefined,
          ),
      };
    });
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
      const credit = await this.wallet.credit(tx, {
        userId: cancelled.userId,
        amount: cancelled.stake,
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
      await tx.insert(sportsbookBetTransaction).values({
        provider: args.provider,
        providerTxId: args.providerTxId,
        providerBetId: args.providerBetId,
        betId: cancelled.id,
        userId: cancelled.userId,
        kind: 'cancel',
        amount: cancelled.stake,
        betVersion: cancelled.version,
        fingerprint,
        cancelReason: args.reason,
        walletTransactionIds: [credit.transactionId],
        balanceAfter: credit.newBalance,
        currency: cancelled.currency,
      });
      await step?.(tx, cancelled);
      return {
        outcome: applied(cancelled, credit.newBalance),
        userId: cancelled.userId,
        moves: [
          {
            transactionId: credit.transactionId,
            amount: cancelled.stake,
            currency: cancelled.currency,
            type: 'bet_reversal',
            direction: 'credit',
          },
        ],
        announce: (playerId) =>
          this.announceBet(
            tx,
            'sportsbook.bet.cancelled',
            {
              ...betEvent({ bet: cancelled, providerTxId: args.providerTxId, playerId }),
              reason: args.reason,
              refunded: cancelled.stake,
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
      if (!isValidSettlement(current, result, payout)) {
        throw invalidAmount(
          args,
          { result, payout, decimals: current.currencyDecimals },
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
      const pays = isPositiveMoney(payout);
      const creditType: WalletTransactionType = result === 'void' ? 'bet_reversal' : 'win';
      const debt =
        pays && creditType === 'win' ? await this.debts.lockOutstanding(tx, current) : undefined;

      const [settled] = await tx
        .update(sportsbookBet)
        .set({ status: 'settled', result, payoutTotal: payout, settledAt: new Date() })
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
        // A void paid the stake back, so the reopen puts it back at stake; any other payout was a win.
        const type = current.result === 'void' ? 'bet' : 'win_reversal';
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
