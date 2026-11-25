/**
 * The money ports a platform service reaches over the signed internal API when the money modules
 * run in another service (`MONEY_SERVICE_URL`, ADR-0063). One route carries every call: the
 * money service answers it from its own binding of the named port, the platform service binds
 * the port to a client of it (`money-remote`).
 */
import * as z from 'zod';
import { UuidSchema } from '../schemas/common.js';
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
import type { LedgerApiV1 } from './ledger-api.js';
import { LEDGER_API_V1 } from './ledger-api.js';
import type { PlayEligibilityProjectionPort } from './play-eligibility.js';
import { LEDGER_PLAY_ELIGIBILITY, PLAY_ELIGIBILITY_PROJECTION } from './play-eligibility.js';
import type { RgLimitLedgerPort } from './rg-limits.js';
import { RG_LIMIT_LEDGER, RG_LIMITS } from './rg-limits.js';
import type { AnyToken } from './token.js';
import { WAGER_TRACKING } from './wager-tracking.js';
import { WALLET_COMMANDS } from './wallet-commands.js';
import type { WalletReader } from './wallet-reader.js';
import { WALLET_READER } from './wallet-reader.js';

export const MONEY_PORTS_ROUTE = '/money/ports/call' as const;

/** Request and reply of {@link MONEY_PORTS_ROUTE}. `args` and `result` use {@link encodeMoneyWire}. */
export const MoneyPortCallWire = {
  input: z.object({
    port: z.string().min(1),
    method: z.string().min(1),
    args: z.string(),
    // Set on a write and kept on its one retry. Every remote write is idempotent at its owner
    // (a keyed ledger op, a versioned projection write, a heartbeat), so a retry applies once.
    idempotencyKey: UuidSchema.optional(),
  }),
  output: z.object({ result: z.string() }),
} as const;

/**
 * How one port method crosses the wire. `arity` is how many leading arguments the caller's
 * call carries (a trailing optional `tx` is left out, so the money service reads on its own
 * connection). `tx` is the position of a required transaction or db argument: never sent, the
 * money service fills it with its own (a transaction on a write, its db on a read). `write`
 * marks a call that changes state: it carries an idempotency key and is retried once.
 */
export type MoneyMethodSpec = {
  readonly arity: number;
  readonly tx?: number;
  readonly write?: true;
};

type Methods<T> = { readonly [K in keyof T]-?: MoneyMethodSpec };

function port<T>(token: AnyToken<unknown>, methods: Methods<T>, remoteFlag = false) {
  return { token, methods: methods as Readonly<Record<string, MoneyMethodSpec>>, remoteFlag };
}

const READ_1 = { arity: 1 } as const;
const READ_2 = { arity: 2 } as const;
const WRITE_1 = { arity: 1, write: true } as const;

/**
 * Every money port a platform module reads, by name. `remoteFlag` sets `remote: true` on the
 * client, which ADR-0062 reads: a lift or loosening reaches the ledger by its event, and the
 * ledger refuses on a stale heartbeat.
 */
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
  LEDGER_API_V1: port<Omit<LedgerApiV1, 'sportsbook'>>(LEDGER_API_V1, {
    bet: WRITE_1,
    win: WRITE_1,
    reverse: WRITE_1,
    closeRound: WRITE_1,
    balance: READ_1,
  }),
  PLAY_ELIGIBILITY_PROJECTION: port<Omit<PlayEligibilityProjectionPort, 'remote'>>(
    PLAY_ELIGIBILITY_PROJECTION,
    {
      write: { arity: 2, tx: 1, write: true },
      reconcile: WRITE_1,
      heartbeat: { arity: 0, write: true },
    },
    true,
  ),
  RG_LIMIT_LEDGER: port<Omit<RgLimitLedgerPort, 'remote'>>(
    RG_LIMIT_LEDGER,
    {
      write: { arity: 2, tx: 1, write: true },
      reconcile: WRITE_1,
      drifted: READ_1,
      heartbeat: { arity: 0, write: true },
      spendFor: { arity: 6, tx: 0 },
    },
    true,
  ),
} as const;

export type MoneyRemotePortName = keyof typeof MONEY_REMOTE_PORTS;

export function isMoneyRemotePortName(name: string): name is MoneyRemotePortName {
  return Object.hasOwn(MONEY_REMOTE_PORTS, name);
}

/** The modules a platform service drops when `MONEY_SERVICE_URL` is set. */
export const MONEY_MODULE_IDS = [
  'wallet',
  'bonus',
  'gamification',
  'gaming',
  'betting',
  'exchange-rate',
] as const;

/**
 * Money ports whose calls take the caller's transaction so they commit with it (a debit, a
 * wager, a grant, a limit check under the caller's lock). They never cross the network: a
 * platform module that requires one keeps the process from booting with `MONEY_SERVICE_URL` set.
 */
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

/**
 * JSON that keeps what port arguments and answers carry beyond JSON: `Date`, `Map` and an
 * `undefined` in an argument list (an omitted optional argument stays omitted).
 */
export function encodeMoneyWire(value: unknown): string {
  // Wrapped, so a call that answers nothing still sends a string.
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
