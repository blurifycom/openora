import { and, asc, inArray } from 'drizzle-orm';
import {
  BonusFundsLockedError,
  type BonusFundLockCommands,
  type BonusOutflowArgs,
  type LockedFunds,
  type LockedFundsArgs,
  type PromoConfig,
  type ReadLockedFundsArgs,
} from '@openora/core/contracts';
import { moneyAdd, moneyCompare, type DrizzleDb, type DrizzleTx } from '@openora/core/server';
import { promoGrant } from '../schema/index.js';
import { lockedFundsOf } from '../shared/fund-buckets.js';
import { isLiveGrantIn, isLiveGrantOf } from '../shared/live-grant.js';

const LOCK_COLUMNS = {
  currency: promoGrant.currency,
  source: promoGrant.source,
  terms: promoGrant.terms,
  unlinked: promoGrant.unlinkedCash,
  linked: promoGrant.linkedCash,
};
import type { GrantLifecycleService } from './grant-lifecycle.service.js';

export class FundLockService implements BonusFundLockCommands {
  constructor(
    private readonly lifecycle: GrantLifecycleService,
    private readonly settings: PromoConfig['bonus'],
  ) {}

  async lockedFunds(
    tx: DrizzleTx,
    { userId, currency, realBalance }: LockedFundsArgs,
  ): Promise<LockedFunds> {
    const live = await tx
      .select(LOCK_COLUMNS)
      .from(promoGrant)
      .where(isLiveGrantIn(userId, currency))
      .orderBy(asc(promoGrant.id))
      .for('share');
    return lockedFundsOf(realBalance, live);
  }

  async readLockedFunds(
    db: DrizzleDb | DrizzleTx,
    { userId, balances }: ReadLockedFundsArgs,
  ): Promise<LockedFunds[]> {
    if (balances.length === 0) {
      return [];
    }
    const live = await db
      .select(LOCK_COLUMNS)
      .from(promoGrant)
      .where(
        and(
          isLiveGrantOf(userId),
          inArray(
            promoGrant.currency,
            balances.map((balance) => balance.currency),
          ),
        ),
      );
    return balances.map(({ currency, realBalance }) =>
      lockedFundsOf(
        realBalance,
        live.filter((grant) => grant.currency === currency),
      ),
    );
  }

  async onOutflow(tx: DrizzleTx, args: BonusOutflowArgs): Promise<void> {
    if (args.outflow === 'withdrawal' && this.settings.withdrawalWhileActive === 'forfeit') {
      await this.lifecycle.forfeitHeld(tx, {
        userId: args.userId,
        reason: 'withdrawal_while_active',
        actor: args.actor,
        note: args.note,
        ...(args.meta === undefined ? {} : { meta: args.meta }),
      });
      return;
    }
    const { locked, free } = await this.lockedFunds(tx, {
      userId: args.userId,
      currency: args.currency,
      realBalance: moneyAdd(args.balanceAfter, args.amount),
    });
    if (moneyCompare(args.balanceAfter, locked) < 0) {
      throw new BonusFundsLockedError(this.settings.lockedFundsMessage, {
        outflow: args.outflow,
        currency: args.currency,
        locked,
        free,
      });
    }
  }
}
