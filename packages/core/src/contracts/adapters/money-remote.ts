import * as z from 'zod';
import { LimitPeriodSchema, LimitTypeSchema } from '../schemas/compliance.js';
import type { AdminGameReporting } from './admin-game-reporting.js';
import { ADMIN_GAME_REPORTING } from './admin-game-reporting.js';
import type { AdminWalletReporting } from './admin-wallet-reporting.js';
import { ADMIN_WALLET_REPORTING } from './admin-wallet-reporting.js';
import { BONUS_GRANT_LEDGER } from './bonus-grant-ledger.js';
import { BONUS_GRANTS } from './bonus-grants.js';
import { BONUS_LIFECYCLE } from './bonus-lifecycle.js';
import { BONUS_WAGERING } from './bonus-wagering.js';
import type { ExchangeRateReader } from './exchange-rate-reader.js';
import { EXCHANGE_RATE_READER } from './exchange-rate-reader.js';
import { GAMING_COMMANDS } from './gaming-commands.js';
import type { MoneyReportingPort, PlayerRankReader } from './money-reporting.js';
import { MONEY_REPORTING, PLAYER_RANK_READER } from './money-reporting.js';
import type { PlayEligibilityProjectionPort } from './play-eligibility.js';
import {
  LEDGER_PLAY_ELIGIBILITY,
  LEDGER_PROJECTIONS,
  LedgerProjectionStaleError,
  PLAY_ELIGIBILITY_PROJECTION,
} from './play-eligibility.js';
import type { RgLimitLedgerPort } from './rg-limits.js';
import { RG_LIMIT_LEDGER, RG_LIMITS, RgRateUnavailableError } from './rg-limits.js';
import type { AnyToken } from './token.js';
import { WAGER_TRACKING } from './wager-tracking.js';
import { WALLET_COMMANDS } from './wallet-commands.js';
import type { WalletReader } from './wallet-reader.js';
import { WALLET_READER } from './wallet-reader.js';

export const MONEY_PORTS_ROUTE = '/money/ports/call' as const;

export const MoneyPortCallWire = {
  input: z.object({
    port: z.string().min(1),
    method: z.string().min(1),
    args: z.string(),
  }),
  output: z.object({ result: z.string() }),
} as const;

export type MoneyMethodSpec = {
  readonly arity: number;
  readonly tx?: number;
  readonly write?: true;
  readonly served?: string;
};

type Methods<T> = { readonly [K in keyof T]-?: MoneyMethodSpec };

function port<T>(token: AnyToken<unknown>, methods: Methods<T>, remoteFlag = false) {
  return { token, methods: methods as Readonly<Record<string, MoneyMethodSpec>>, remoteFlag };
}

const READ_1 = { arity: 1 } as const;
const READ_2 = { arity: 2 } as const;
const WRITE_1 = { arity: 1, write: true } as const;
const REMOTE_PROJECTION_WRITE = {
  arity: 2,
  tx: 1,
  write: true,
  served: 'writeFromRemote',
} as const;

export const MONEY_REMOTE_PORTS = {
  WALLET_READER: port<WalletReader>(WALLET_READER, {
    getLifetimeDeposit: READ_1,
    getBalances: READ_1,
    getWithdrawalCountInWindow: READ_2,
    getWithdrawalCountsInWindow: READ_2,
    findByProviderRef: READ_2,
    findOwnProviderTransaction: READ_2,
    getBalance: READ_1,
    isFirstDeposit: READ_2,
    getLifetimeWithdrawals: READ_1,
    getLastDeposit: READ_1,
    getLastDepositAts: READ_1,
    getTurnoverSince: READ_2,
    getWithdrawalRequestsSince: READ_2,
    getDepositsByCurrency: READ_1,
    getMoneyByWindow: READ_2,
    hasWallet: { arity: 2, tx: 1 },
    sumProviderTransactions: { arity: 2, tx: 1 },
  }),
  EXCHANGE_RATE_READER: port<ExchangeRateReader>(EXCHANGE_RATE_READER, {
    getRate: READ_2,
    convert: { arity: 3 },
  }),
  ADMIN_WALLET_REPORTING: port<AdminWalletReporting>(ADMIN_WALLET_REPORTING, {
    totals: { arity: 0 },
    listTransactions: READ_1,
    getTransaction: READ_1,
  }),
  ADMIN_GAME_REPORTING: port<AdminGameReporting>(ADMIN_GAME_REPORTING, {
    listGamePerformance: READ_1,
    getGamePerformanceTrend: READ_1,
    getPlayerStats: READ_1,
    rankGamesByRounds: READ_1,
    rankAllGamesByRounds: READ_1,
    rankGamesPerCurrency: READ_1,
    rankProvidersPerCurrency: READ_1,
  }),
  MONEY_REPORTING: port<MoneyReportingPort>(MONEY_REPORTING, {
    summary: READ_1,
    ggr: READ_1,
    products: READ_1,
    paymentsFlow: READ_1,
    funnelActivity: READ_1,
  }),
  PLAYER_RANK_READER: port<PlayerRankReader>(PLAYER_RANK_READER, {
    getRankName: READ_1,
  }),
  PLAY_ELIGIBILITY_PROJECTION: port<Omit<PlayEligibilityProjectionPort, 'remote'>>(
    PLAY_ELIGIBILITY_PROJECTION,
    {
      write: REMOTE_PROJECTION_WRITE,
      reconcile: WRITE_1,
      heartbeat: { arity: 0, write: true },
    },
    true,
  ),
  RG_LIMIT_LEDGER: port<Omit<RgLimitLedgerPort, 'remote'>>(
    RG_LIMIT_LEDGER,
    {
      write: REMOTE_PROJECTION_WRITE,
      reconcile: WRITE_1,
      drifted: READ_1,
      heartbeat: { arity: 0, write: true },
      spendFor: { arity: 6, tx: 0 },
    },
    true,
  ),
} as const;

export type MoneyRemotePortName = keyof typeof MONEY_REMOTE_PORTS;

export const MoneyPortErrorWire = z.discriminatedUnion('code', [
  z.object({
    code: z.literal('rg_rate_unavailable'),
    limitType: LimitTypeSchema,
    period: LimitPeriodSchema,
    missingCurrency: z.string(),
    limitCurrency: z.string(),
  }),
  z.object({
    code: z.literal('ledger_projection_stale'),
    projection: z.enum(LEDGER_PROJECTIONS),
    lastBeatAt: z.string().nullable(),
  }),
]);
export type MoneyPortErrorWire = z.infer<typeof MoneyPortErrorWire>;

export function moneyPortErrorWireOf(err: unknown): MoneyPortErrorWire | null {
  if (err instanceof RgRateUnavailableError) {
    const { limitType, period, missingCurrency, limitCurrency } = err;
    return { code: 'rg_rate_unavailable', limitType, period, missingCurrency, limitCurrency };
  }
  if (err instanceof LedgerProjectionStaleError) {
    return {
      code: 'ledger_projection_stale',
      projection: err.projection,
      lastBeatAt: err.lastBeatAt?.toISOString() ?? null,
    };
  }
  return null;
}

export function moneyPortErrorFromWire(wire: MoneyPortErrorWire): Error {
  switch (wire.code) {
    case 'rg_rate_unavailable':
      return new RgRateUnavailableError(
        wire.limitType,
        wire.period,
        wire.missingCurrency,
        wire.limitCurrency,
      );
    case 'ledger_projection_stale':
      return new LedgerProjectionStaleError(
        wire.projection,
        wire.lastBeatAt === null ? null : new Date(wire.lastBeatAt),
      );
  }
}

export function isMoneyRemotePortName(name: string): name is MoneyRemotePortName {
  return Object.hasOwn(MONEY_REMOTE_PORTS, name);
}

export const MONEY_MODULE_IDS = [
  'wallet',
  'bonus',
  'gamification',
  'gaming',
  'betting',
  'exchange-rate',
] as const;

export const MONEY_TX_BOUND_PORTS: readonly symbol[] = [
  WALLET_COMMANDS,
  WAGER_TRACKING,
  BONUS_LIFECYCLE,
  BONUS_WAGERING,
  BONUS_GRANTS,
  BONUS_GRANT_LEDGER,
  GAMING_COMMANDS,
  RG_LIMITS,
  LEDGER_PLAY_ELIGIBILITY,
];

export function encodeMoneyWire(value: unknown): string {
  return JSON.stringify([value], function (this: Record<string, unknown>, key, encoded: unknown) {
    const raw = this[key];
    if (raw instanceof Date) {
      return { $date: raw.toISOString() };
    }
    if (raw instanceof Map) {
      return { $map: [...raw] };
    }
    if (raw === undefined && Array.isArray(this)) {
      return { $undefined: true };
    }
    return encoded;
  });
}

export function decodeMoneyWire(text: string): unknown {
  const wrapped: unknown = JSON.parse(text, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return value;
    }
    if ('$date' in value && typeof value.$date === 'string') {
      return new Date(value.$date);
    }
    if ('$map' in value && Array.isArray(value.$map)) {
      return new Map(value.$map as [unknown, unknown][]);
    }
    if ('$undefined' in value) {
      return undefined;
    }
    return value;
  });
  if (!Array.isArray(wrapped) || wrapped.length !== 1) {
    throw new Error('not a money wire value');
  }
  return wrapped[0];
}
