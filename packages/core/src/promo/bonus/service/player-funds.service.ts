import type { BonusFundLockCommands, Uuid, WalletReader } from '@openora/core/contracts';
import type { DrizzleService } from '@openora/core/server';
import type { AdminPlayerFunds } from '../contract/index.js';

const SNAPSHOT_READ = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

export class PlayerFundsService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly wallet: Pick<WalletReader, 'getBalances'>,
    private readonly locks: Pick<BonusFundLockCommands, 'readLockedFunds'>,
  ) {}

  /** An unknown player reads as no balances, like the grant list. */
  read(userId: Uuid): Promise<AdminPlayerFunds> {
    return this.drizzle.db.transaction(async (tx) => {
      const { activeCurrency, balances } = await this.wallet.getBalances(userId, tx);
      const locks = await this.locks.readLockedFunds(tx, {
        userId,
        balances: balances.map(({ currency, balance }) => ({
          currency: currency.toUpperCase(),
          realBalance: balance,
        })),
      });
      return {
        activeCurrency,
        balances: balances.map((row, i) => {
          const lock = locks[i];
          if (!lock) {
            throw new Error(`no lock reading for ${row.currency}`);
          }
          return { ...row, ...lock };
        }),
      };
    }, SNAPSHOT_READ);
  }
}
