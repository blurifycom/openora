// Ledger API v1 (LEDGER_API_V1): the in-process implementation of the surface provider bridges
// and the sportsbook move money through. Each keyed op owns its transaction: it locks its keys,
// answers a stored key from `ledger_api_request`, or moves the money through WALLET_COMMANDS,
// adds it to the round through GAMING_COMMANDS, writes the outbox events and stores its answer,
// all in that one transaction. No money logic lives here; it only orders the ports' calls.
import { createHash } from 'node:crypto';
import {
  GamingRoundOwnerMismatchError,
  GamingUnknownGameError,
  LedgerV1BalanceArgsSchema,
  LedgerV1BetArgsSchema,
  LedgerV1CloseRoundArgsSchema,
  LedgerV1MoveSchema,
  LedgerV1ReverseArgsSchema,
  LedgerV1WinArgsSchema,
  MaxBetExceededError,
  MONEY_SCALE,
  RgLimitExceededError,
  WALLET_BET_ALREADY_REVERSED,
  WALLET_REVERSAL_UNMATCHED,
  WalletCommandAmountError,
  WalletReplayMismatchError,
  type DomainEventName,
  type DomainEventPayload,
  type GamingAccumulateExternalRoundArgs,
  type GamingCommands,
  type IdentityReader,
  type LedgerApiV1,
  type LedgerV1BalanceArgs,
  type LedgerV1BalanceOutcome,
  type LedgerV1BetArgs,
  type LedgerV1CloseRoundArgs,
  type LedgerV1CloseRoundOutcome,
  type LedgerV1KeyedOperation,
  type LedgerV1Move,
  type LedgerV1MoveOutcome,
  type LedgerV1RefusalReason,
  type LedgerV1Refused,
  type LedgerV1ReverseArgs,
  type LedgerV1WinArgs,
  type SportsbookLedger,
  type Uuid,
  type WalletCommands,
  type WalletDebitOutcome,
  type WalletTransactionType,
} from '@openora/core/contracts';
import {
  createLogger,
  isPositiveMoney,
  moneyFloorToScale,
  withAdvisoryXactLocks,
  type DrizzleService,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import { and, eq } from 'drizzle-orm';
import type * as z from 'zod';
import { ledgerApiRequest, wallet, walletTransaction } from '../schema/index.js';
import { WalletRgRestrictedError } from './wallet-commands.service.js';
import { providerRefCondition, readWalletBalance } from './wallet.service.js';

const log = createLogger('wallet:ledger-api');

export type LedgerApiDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  walletCommands: WalletCommands;
  identityReader: IdentityReader;
  /** Resolved per call: the gaming and sportsbook modules load after wallet, and are optional. */
  gamingCommands: () => GamingCommands;
  sportsbookLedger: () => SportsbookLedger;
};

/** Thrown inside a transaction to roll it back and answer a refusal. */
class LedgerRefusal extends Error {
  constructor(
    readonly reason: LedgerV1RefusalReason,
    readonly available?: string,
  ) {
    super(`ledger api refused: ${reason}`);
    this.name = 'LedgerRefusal';
  }
}

/**
 * The wallet already held the key from a move made outside this API (a bridge's direct call
 * before it moved here): rolled back, and answered as a replay with what the wallet reports.
 */
class WalletLevelReplay extends Error {
  constructor(readonly move: LedgerV1Move) {
    super('ledger api: wallet replayed the key');
    this.name = 'WalletLevelReplay';
  }
}

const REFUSAL_BY_ERROR: ReadonlyArray<
  readonly [new (...args: never[]) => Error, LedgerV1RefusalReason]
> = [
  [WalletReplayMismatchError, 'fingerprint_mismatch'],
  [WalletRgRestrictedError, 'player_blocked'],
  [RgLimitExceededError, 'limit'],
  [MaxBetExceededError, 'max_bet_exceeded'],
  [GamingUnknownGameError, 'unknown_game'],
  [GamingRoundOwnerMismatchError, 'round_mismatch'],
  [WalletCommandAmountError, 'invalid_amount'],
];

/** A malformed amount refuses as `invalid_amount`; any other malformed field is the caller's bug. */
function parseArgs<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }
  if (parsed.error.issues.every((issue) => issue.path[0] === 'amount')) {
    throw new LedgerRefusal('invalid_amount');
  }
  throw parsed.error;
}

const canonicalDecimal = (value: string | undefined) =>
  value === undefined ? null : moneyFloorToScale(value, MONEY_SCALE);

/** sha256 over the canonical request, so '10' and '10.00' are one request and '10' and '11' two. */
function fingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** A UUID's case is not part of it, so `A1..` and `a1..` are one request. */
const uuid = (id: string) => id.toLowerCase();

function reverseFingerprint(args: ReverseKey): string {
  return fingerprint([
    'reverse',
    args.providerName,
    uuid(args.userId),
    uuid(args.gameId),
    args.targetRefId,
  ]);
}

type LedgerKey = Pick<LedgerV1BetArgs, 'providerName' | 'providerRefId'>;
type ReverseKey = Pick<LedgerV1ReverseArgs, 'providerName' | 'userId' | 'gameId' | 'targetRefId'>;

const lockKey = (providerName: string, ref: string) => `ledger-api:${providerName}:${ref}`;

export class LedgerApiService implements LedgerApiV1 {
  readonly sportsbook: LedgerApiV1['sportsbook'];

  constructor(private readonly deps: LedgerApiDeps) {
    this.sportsbook = {
      reserve: (args) => deps.sportsbookLedger().reserve(args),
      confirm: (args) => deps.sportsbookLedger().confirm(args),
      cancel: (args) => deps.sportsbookLedger().cancel(args),
      settle: (args) => deps.sportsbookLedger().settle(args),
      reopen: (args) => deps.sportsbookLedger().reopen(args),
    };
  }

  bet(input: LedgerV1BetArgs): Promise<LedgerV1MoveOutcome> {
    return this.answer(async () => {
      const args = parseArgs(LedgerV1BetArgsSchema, input);
      if (!isPositiveMoney(args.amount)) {
        throw new LedgerRefusal('invalid_amount');
      }
      const { providerName, providerRefId, userId, gameId, externalRoundId, currency } = args;
      const wager = args.wager;
      const print = fingerprint([
        'bet',
        providerName,
        uuid(userId),
        uuid(gameId),
        externalRoundId,
        currency,
        canonicalDecimal(args.amount),
        args.reverseRef ?? null,
        wager?.product ?? null,
        canonicalDecimal(wager?.rtp),
        wager?.categorySlug ?? null,
        wager?.providerGameKey ?? null,
      ]);
      const playerId = await this.deps.identityReader.getPlayerIdByUserIdSafe(userId);
      const providerRef = { providerName, providerRefId, externalRoundId };
      const lockRefs = args.reverseRef === undefined ? [] : [args.reverseRef];

      return this.keyed(providerRef, 'bet', print, lockRefs, async (tx) => {
        const reverseKey =
          args.reverseRef === undefined
            ? undefined
            : { providerName, providerRefId: args.reverseRef };
        if (reverseKey && (await this.findRequest(tx, reverseKey))) {
          throw new LedgerRefusal('fingerprint_mismatch');
        }
        if (reverseKey && (await this.isReversed(tx, providerName, providerRefId))) {
          throw new LedgerRefusal('already_reversed');
        }
        const round = await this.deps.gamingCommands().accumulateExternalRound(tx, {
          gameId,
          userId,
          currency,
          externalRoundId,
          betDelta: args.amount,
          wager: { product: wager?.product ?? null, rtp: wager?.rtp ?? null },
        });
        if (round.wager.product === null) {
          throw new LedgerRefusal('unknown_product');
        }
        const debit = await this.deps.walletCommands.debit(tx, {
          userId,
          amount: args.amount,
          currency,
          type: 'bet',
          context: {
            provider: providerName,
            product: round.wager.product,
            gameId,
            ...(round.wager.rtp === null ? {} : { rtp: round.wager.rtp }),
            ...(wager?.categorySlug === undefined ? {} : { categorySlug: wager.categorySlug }),
            ...(wager?.providerGameKey === undefined
              ? {}
              : { providerGameKey: wager.providerGameKey }),
          },
          providerRef,
        });
        if (!debit.ok) {
          throw new LedgerRefusal('insufficient_funds', debit.available);
        }
        if (!debit.moved) {
          throw new WalletLevelReplay({
            transactionId: debit.replayedTransactionId ?? null,
            reversalTransactionId: null,
            roundId: round.roundId,
            balance: debit.newBalance,
            currency: debit.currency,
          });
        }
        await this.emitDebit(tx, userId, playerId, args.amount, debit);
        const move: LedgerV1Move = {
          transactionId: debit.transactionId,
          reversalTransactionId: null,
          roundId: round.roundId,
          balance: debit.newBalance,
          currency: debit.currency,
        };
        if (!reverseKey) {
          return { move };
        }

        // The provider rolled this bet back before it arrived: return the stake in this same
        // transaction, and answer the rollback's own key from now on.
        const reversal = await this.returnStake(tx, {
          userId,
          playerId,
          gameId,
          round: { externalRoundId },
          providerRef: { ...reverseKey, externalRoundId },
          betTransactionId: debit.transactionId,
          amount: args.amount,
          currency: debit.currency,
        });
        await this.storeRequest(tx, reverseKey, {
          operation: 'reverse',
          fingerprint: reverseFingerprint({
            providerName,
            userId,
            gameId,
            targetRefId: providerRefId,
          }),
          targetRefId: providerRefId,
          response: { ...reversal, reversalTransactionId: null },
        });
        return {
          move: {
            ...move,
            reversalTransactionId: reversal.transactionId,
            balance: reversal.balance,
          },
        };
      });
    });
  }

  win(input: LedgerV1WinArgs): Promise<LedgerV1MoveOutcome> {
    return this.answer(async () => {
      const args = parseArgs(LedgerV1WinArgsSchema, input);
      const { providerName, providerRefId, userId, gameId, externalRoundId, currency } = args;
      const print = fingerprint([
        'win',
        providerName,
        uuid(userId),
        uuid(gameId),
        externalRoundId,
        currency,
        canonicalDecimal(args.amount),
        args.isFinal ?? false,
      ]);
      const playerId = await this.deps.identityReader.getPlayerIdByUserIdSafe(userId);
      const providerRef = { providerName, providerRefId, externalRoundId };

      return this.keyed(providerRef, 'win', print, [], async (tx) => {
        const round = await this.deps.gamingCommands().accumulateExternalRound(tx, {
          gameId,
          userId,
          currency,
          externalRoundId,
          winDelta: args.amount,
          ...(args.isFinal ? { isFinal: true } : {}),
        });
        if (round.ended) {
          await this.emit(tx, 'gaming.round.ended', { roundId: round.roundId, userId, playerId });
        }
        if (!isPositiveMoney(args.amount)) {
          return {
            move: {
              transactionId: null,
              reversalTransactionId: null,
              roundId: round.roundId,
              balance: await this.readBalance(tx, userId, currency),
              currency,
            },
          };
        }
        const credit = await this.deps.walletCommands.credit(tx, {
          userId,
          amount: args.amount,
          currency,
          type: 'win',
          allowNewCurrency: true,
          providerRef,
        });
        const moved = this.assertCredited(credit, round.roundId, currency);
        await this.emitMove(tx, userId, playerId, {
          amount: args.amount,
          currency,
          transactionId: moved.transactionId,
          type: 'win',
          direction: 'credit',
        });
        return {
          move: {
            transactionId: moved.transactionId,
            reversalTransactionId: null,
            roundId: round.roundId,
            balance: moved.newBalance,
            currency,
          },
        };
      });
    });
  }

  reverse(input: LedgerV1ReverseArgs): Promise<LedgerV1MoveOutcome> {
    return this.answer(async () => {
      const args = parseArgs(LedgerV1ReverseArgsSchema, input);
      const { providerName, providerRefId, userId, gameId, targetRefId } = args;
      const print = reverseFingerprint(args);
      const playerId = await this.deps.identityReader.getPlayerIdByUserIdSafe(userId);

      return this.keyed(
        { providerName, providerRefId },
        'reverse',
        print,
        [targetRefId],
        async (tx) => {
          if (await this.isReversed(tx, providerName, targetRefId)) {
            throw new LedgerRefusal('already_reversed');
          }
          const [bet] = await tx
            .select({
              id: walletTransaction.id,
              amount: walletTransaction.amount,
              currency: walletTransaction.currency,
              externalRoundId: walletTransaction.externalRoundId,
            })
            .from(walletTransaction)
            .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
            .where(
              and(
                providerRefCondition(providerName, targetRefId),
                eq(wallet.userId, userId),
                eq(walletTransaction.type, 'bet'),
                eq(walletTransaction.direction, 'debit'),
                eq(walletTransaction.status, 'completed'),
              ),
            )
            .limit(1);
          if (!bet?.externalRoundId) {
            throw new LedgerRefusal('bet_not_found');
          }
          // A bet placed here keyed its round and its row with one id. Any other bet's round id
          // may not be its round's key, so the caller may name the round, which must then be
          // this player's existing round of this game and currency still holding the stake.
          const placedHere = await this.findRequest(tx, {
            providerName,
            providerRefId: targetRefId,
          });
          const namedRound = placedHere ? undefined : args.externalRoundId;
          if (placedHere && args.externalRoundId && args.externalRoundId !== bet.externalRoundId) {
            log.warn(
              { providerName, providerRefId, targetRefId, named: args.externalRoundId },
              "ledger api: a reverse named another round than its bet's; using the bet's round",
            );
          }
          const reversal = await this.returnStake(tx, {
            userId,
            playerId,
            gameId,
            round: namedRound
              ? { externalRoundId: namedRound, existingRoundOnly: true }
              : { externalRoundId: bet.externalRoundId },
            providerRef: { providerName, providerRefId, externalRoundId: bet.externalRoundId },
            betTransactionId: bet.id,
            amount: bet.amount,
            currency: bet.currency,
          });
          return { move: { ...reversal, reversalTransactionId: null }, targetRefId };
        },
      );
    });
  }

  closeRound(input: LedgerV1CloseRoundArgs): Promise<LedgerV1CloseRoundOutcome> {
    return this.answer(async () => {
      const args = LedgerV1CloseRoundArgsSchema.parse(input);
      const playerId = await this.deps.identityReader.getPlayerIdByUserIdSafe(args.userId);
      return this.deps.drizzle.db.transaction(async (tx) => {
        const round = await this.deps
          .gamingCommands()
          .accumulateExternalRound(tx, { ...args, isFinal: true });
        if (round.ended) {
          await this.emit(tx, 'gaming.round.ended', {
            roundId: round.roundId,
            userId: args.userId,
            playerId,
          });
        }
        return {
          status: 'closed' as const,
          roundId: round.roundId,
          betAmount: round.betAmount,
          winAmount: round.winAmount,
        };
      });
    });
  }

  async balance(input: LedgerV1BalanceArgs): Promise<LedgerV1BalanceOutcome> {
    const { userId, currency } = LedgerV1BalanceArgsSchema.parse(input);
    const [row] = await this.deps.drizzle.db
      .select({ id: wallet.id })
      .from(wallet)
      .where(eq(wallet.userId, userId));
    if (!row) {
      return { status: 'refused', reason: 'wallet_not_found' };
    }
    return {
      status: 'ok',
      balance: await readWalletBalance(this.deps.drizzle.db, row.id, currency),
      currency,
    };
  }

  /** Turns a refusal, or a known port error, into a typed answer; anything else is thrown. */
  private async answer<T>(run: () => Promise<T>): Promise<T | LedgerV1Refused> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof LedgerRefusal) {
        return {
          status: 'refused',
          reason: err.reason,
          ...(err.available === undefined ? {} : { available: err.available }),
        };
      }
      const mapped = REFUSAL_BY_ERROR.find(([type]) => err instanceof type);
      if (mapped) {
        if (mapped[1] === 'fingerprint_mismatch') {
          log.warn({ err }, 'ledger api: a key was reused by a different request');
        }
        if (mapped[1] === 'round_mismatch') {
          log.warn({ err }, 'ledger api: a move was refused on a round it does not match');
        }
        return { status: 'refused', reason: mapped[1] };
      }
      throw err;
    }
  }

  private keyed(
    key: LedgerKey,
    operation: LedgerV1KeyedOperation,
    print: string,
    lockRefs: readonly string[],
    move: (tx: DrizzleTx) => Promise<{ move: LedgerV1Move; targetRefId?: string }>,
  ): Promise<LedgerV1MoveOutcome> {
    const keys = [key.providerRefId, ...lockRefs].map((ref) => lockKey(key.providerName, ref));
    return this.deps.drizzle.db
      .transaction((tx) =>
        withAdvisoryXactLocks(tx, keys, async (): Promise<LedgerV1MoveOutcome> => {
          const stored = await this.findRequest(tx, key);
          if (stored) {
            if (stored.fingerprint !== print) {
              log.warn(
                { ...key, operation },
                'ledger api: a key was reused by a different request',
              );
              throw new LedgerRefusal('fingerprint_mismatch');
            }
            return { status: 'replayed', ...LedgerV1MoveSchema.parse(stored.response) };
          }
          const applied = await move(tx);
          await this.storeRequest(tx, key, {
            operation,
            fingerprint: print,
            targetRefId: applied.targetRefId ?? null,
            response: applied.move,
          });
          return { status: 'applied', ...applied.move };
        }),
      )
      .catch((err: unknown): LedgerV1MoveOutcome => {
        if (err instanceof WalletLevelReplay) {
          return { status: 'replayed', ...err.move };
        }
        throw err;
      });
  }

  /** A reversal through this API already took `targetRefId`'s stake back. */
  private async isReversed(
    tx: DrizzleTx,
    providerName: LedgerKey['providerName'],
    targetRefId: LedgerKey['providerRefId'],
  ): Promise<boolean> {
    const [reversal] = await tx
      .select({ providerRefId: ledgerApiRequest.providerRefId })
      .from(ledgerApiRequest)
      .where(
        and(
          eq(ledgerApiRequest.providerName, providerName),
          eq(ledgerApiRequest.targetRefId, targetRefId),
        ),
      )
      .limit(1);
    return reversal !== undefined;
  }

  private async findRequest(
    tx: DrizzleTx,
    key: LedgerKey,
  ): Promise<{ fingerprint: string; response: unknown } | undefined> {
    const [row] = await tx
      .select({ fingerprint: ledgerApiRequest.fingerprint, response: ledgerApiRequest.response })
      .from(ledgerApiRequest)
      .where(
        and(
          eq(ledgerApiRequest.providerName, key.providerName),
          eq(ledgerApiRequest.providerRefId, key.providerRefId),
        ),
      );
    return row;
  }

  private async storeRequest(
    tx: DrizzleTx,
    key: LedgerKey,
    row: {
      operation: LedgerV1KeyedOperation;
      fingerprint: string;
      targetRefId: string | null;
      response: LedgerV1Move;
    },
  ): Promise<void> {
    await tx.insert(ledgerApiRequest).values({ ...key, ...row });
  }

  /**
   * Credits a stake back as `bet_reversal`, on the bet's own round id so the wallet matches it to
   * its bet, and takes it off `round`.
   */
  private async returnStake(
    tx: DrizzleTx,
    args: {
      userId: Uuid;
      playerId: string | null;
      gameId: Uuid;
      round: Pick<GamingAccumulateExternalRoundArgs, 'externalRoundId' | 'existingRoundOnly'>;
      providerRef: LedgerKey & { externalRoundId: LedgerV1BetArgs['externalRoundId'] };
      betTransactionId: Uuid;
      amount: string;
      currency: string;
    },
  ): Promise<Omit<LedgerV1Move, 'reversalTransactionId'>> {
    const { userId, playerId, amount, currency, providerRef } = args;
    const round = await this.deps.gamingCommands().accumulateExternalRound(tx, {
      gameId: args.gameId,
      userId,
      currency,
      ...args.round,
      betDelta: `-${amount}`,
    });
    const credit = await this.deps.walletCommands.credit(tx, {
      userId,
      amount,
      currency,
      type: 'bet_reversal',
      allowNewCurrency: true,
      providerRef,
      reversesTransactionId: args.betTransactionId,
    });
    const moved = this.assertCredited(credit, round.roundId, currency);
    await this.emitMove(tx, userId, playerId, {
      amount,
      currency,
      transactionId: moved.transactionId,
      type: 'bet_reversal',
      direction: 'credit',
    });
    return {
      transactionId: moved.transactionId,
      roundId: round.roundId,
      balance: moved.newBalance,
      currency,
    };
  }

  private assertCredited(
    credit: Awaited<ReturnType<WalletCommands['credit']>>,
    roundId: Uuid,
    currency: string,
  ): { transactionId: string; newBalance: string } {
    if (!credit.ok) {
      if (credit.reason === 'wallet not found') {
        throw new LedgerRefusal('wallet_not_found');
      }
      if (credit.reason === WALLET_BET_ALREADY_REVERSED) {
        throw new LedgerRefusal('already_reversed');
      }
      if (credit.reason === WALLET_REVERSAL_UNMATCHED) {
        throw new LedgerRefusal('bet_not_found');
      }
      throw new Error(`ledger api: credit refused: ${credit.reason}`);
    }
    if (!credit.moved) {
      throw new WalletLevelReplay({
        transactionId: credit.replayedTransactionId ?? null,
        reversalTransactionId: null,
        roundId,
        balance: credit.newBalance,
        currency,
      });
    }
    return credit;
  }

  private async readBalance(tx: DrizzleTx, userId: Uuid, currency: string): Promise<string> {
    const [row] = await tx.select({ id: wallet.id }).from(wallet).where(eq(wallet.userId, userId));
    if (!row) {
      throw new LedgerRefusal('wallet_not_found');
    }
    return readWalletBalance(tx, row.id, currency);
  }

  /** The bet's own move, whatever wager tracking credited with it, and a bonus it completed. */
  private async emitDebit(
    tx: DrizzleTx,
    userId: Uuid,
    playerId: string | null,
    amount: string,
    debit: Extract<WalletDebitOutcome, { moved: true }>,
  ): Promise<void> {
    await this.emitMove(tx, userId, playerId, {
      amount,
      currency: debit.currency,
      transactionId: debit.transactionId,
      type: 'bet',
      direction: 'debit',
    });
    for (const credit of debit.wagerTrackingCredits ?? []) {
      await this.emitMove(tx, userId, playerId, {
        amount: credit.amount,
        currency: credit.currency,
        transactionId: credit.transactionId,
        type: 'cashback',
        direction: 'credit',
      });
    }
    if (debit.completed) {
      await this.emit(tx, 'promo.bonus.completed', {
        userId,
        grantId: debit.completed.grantId,
        currency: debit.currency,
        convertedAmount: debit.completed.convertedAmount,
      });
    }
  }

  private emitMove(
    tx: DrizzleTx,
    userId: Uuid,
    playerId: string | null,
    move: {
      amount: string;
      currency: string;
      transactionId: Uuid;
      type: WalletTransactionType;
      direction: 'credit' | 'debit';
    },
  ): Promise<void> {
    return this.emit(tx, 'wallet.balance.changed', { userId, playerId, ...move });
  }

  private async emit<E extends DomainEventName>(
    tx: DrizzleTx,
    event: E,
    payload: DomainEventPayload<E>,
  ): Promise<void> {
    await this.deps.events.emitInTransaction(tx, event, payload);
  }
}
