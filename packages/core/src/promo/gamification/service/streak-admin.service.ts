import type { AuditWritePort, Uuid } from '@openora/core/contracts';
import type { DrizzleService } from '@openora/core/server';
import { promoStreakConfig } from '../schema/index.js';
import type { StreakConfig } from '../contract/index.js';
import { StreakConfigNotSetError } from './streak.service.js';

const CONFIG_COLUMNS = {
  currency: promoStreakConfig.currency,
  dailyMinWager: promoStreakConfig.dailyMinWager,
  eligibleProducts: promoStreakConfig.eligibleProducts,
  milestones: promoStreakConfig.milestones,
  resetAfterDay: promoStreakConfig.resetAfterDay,
};

/**
 * The operator's side of the streak: the daily threshold, which products count, and the
 * milestone list, read and replaced as one config - the same singleton shape
 * `RankAdminService` uses for `promoRankConfig`. Every change is audited with a before/after, so
 * an operator's change to what a milestone pays is traceable the way a change to a rank tier is.
 *
 * An edit applies from the next qualifying bet onward; it never rewrites a player's own state.
 */
export class StreakAdminService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
  ) {}

  async getConfig(): Promise<StreakConfig> {
    const [config] = await this.drizzle.db.select(CONFIG_COLUMNS).from(promoStreakConfig);
    if (!config) {
      throw new StreakConfigNotSetError('global');
    }
    return config;
  }

  async setConfig(adminId: Uuid, input: StreakConfig): Promise<StreakConfig> {
    const config = {
      currency: input.currency,
      dailyMinWager: input.dailyMinWager,
      eligibleProducts: [...new Set(input.eligibleProducts)],
      milestones: input.milestones,
      resetAfterDay: input.resetAfterDay,
    };
    return this.drizzle.db.transaction(async (tx) => {
      const [before] = await tx.select(CONFIG_COLUMNS).from(promoStreakConfig).for('update');
      await tx
        .insert(promoStreakConfig)
        .values({ ...config, updatedBy: adminId })
        .onConflictDoUpdate({
          target: promoStreakConfig.singletonKey,
          set: { ...config, updatedBy: adminId },
        });
      await this.audit.recordInTransaction(tx, {
        actorId: adminId,
        actorType: 'admin',
        action: 'promo.streak_config.set',
        resourceType: 'promo_streak_config',
        resourceId: null,
        before: before ?? null,
        after: config,
      });
      return config;
    });
  }
}
