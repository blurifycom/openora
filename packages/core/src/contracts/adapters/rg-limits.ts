import type { LimitType, LimitPeriod, RgLimitErrorReason } from '../schemas/compliance.js';
import type { RgLimitsSnapshot } from '../schemas/ledger.js';
import { createSealedToken, type SealedToken } from './token.js';

export type RgLimitDecision =
  | { allowed: true }
  | {
      allowed: false;
      limitType: LimitType;
      period: LimitPeriod;
      limit: string;
      used: string;
      currency?: string | null;
    };

export type RgLimitExceededData = {
  reason: RgLimitErrorReason;
  limitType: LimitType;
  period: LimitPeriod;
  limit: string;
  used: string;
  currency: string | null;
};

export class RgLimitExceededError extends Error {
  readonly data: RgLimitExceededData;

  constructor(reason: RgLimitErrorReason, decision: Extract<RgLimitDecision, { allowed: false }>) {
    super(
      `Refused: this would exceed the ${decision.period} ${decision.limitType} limit of ${decision.limit}${decision.currency ? ` ${decision.currency}` : ''} (${decision.used} already used)`,
    );
    this.name = 'RgLimitExceededError';
    this.data = {
      reason,
      limitType: decision.limitType,
      period: decision.period,
      limit: decision.limit,
      used: decision.used,
      currency: decision.currency ?? null,
    };
  }
}

export class RgRateUnavailableError extends Error {
  constructor(
    readonly limitType: LimitType,
    readonly period: LimitPeriod,
    readonly missingCurrency: string,
    readonly limitCurrency: string,
  ) {
    super(
      `No exchange rate available to convert ${missingCurrency} into ${limitCurrency} for the ${period} ${limitType} limit`,
    );
    this.name = 'RgRateUnavailableError';
  }
}

const PERIOD_MS: Record<Exclude<LimitPeriod, 'session'>, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export const limitSlotKey = (userId: string, type: string, period: string) =>
  `rg-limit:${userId}:${type}:${period}`;

export function periodWindow(period: LimitPeriod, now: Date): { from: Date; to: Date } {
  if (period === 'session') {
    return { from: now, to: now };
  }
  return { from: new Date(now.getTime() - PERIOD_MS[period]), to: now };
}

export type RgLimitsPort = {
  checkDeposit(
    tx: unknown,
    userId: string,
    amount: string,
    currency: string,
  ): Promise<RgLimitDecision>;
  checkWager(
    tx: unknown,
    userId: string,
    amount: string,
    currency: string,
  ): Promise<RgLimitDecision>;
  referenceCurrency(tx: unknown, userId: string): Promise<string | null>;
};

export const RG_LIMITS: SealedToken<RgLimitsPort> = createSealedToken<RgLimitsPort>('RG_LIMITS');

export type RgLimitLedgerPort = {
  write(snapshot: RgLimitsSnapshot, tx: unknown): Promise<void>;
  reconcile(snapshots: readonly RgLimitsSnapshot[]): Promise<number>;
  drifted(snapshots: readonly RgLimitsSnapshot[]): Promise<string[]>;
  heartbeat(): Promise<void>;
  readonly remote?: boolean;
  spendFor(
    db: unknown,
    userId: string,
    type: LimitType,
    period: LimitPeriod,
    from: Date,
    limitCurrency: string,
  ): Promise<string>;
};

export const RG_LIMIT_LEDGER: SealedToken<RgLimitLedgerPort> =
  createSealedToken<RgLimitLedgerPort>('RG_LIMIT_LEDGER');

export type RgLimitsSourcePort = {
  page(afterUserId: string | null, limit: number): Promise<RgLimitsSnapshot[]>;
  snapshots(userIds: readonly string[]): Promise<RgLimitsSnapshot[]>;
  repair(userIds: readonly string[]): Promise<string[]>;
};

export const RG_LIMITS_SOURCE: SealedToken<RgLimitsSourcePort> =
  createSealedToken<RgLimitsSourcePort>('RG_LIMITS_SOURCE');
