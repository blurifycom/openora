import { gt, sql } from 'drizzle-orm';
import type { AuditWritePort, ClientMeta, Uuid } from '@openora/core/contracts';
import type { DrizzleService } from '@openora/core/server';
import { promoPlayerStreak, promoStreakConfig } from '../schema/index.js';
import { STREAK_CURRENCY, type StreakConfig } from '../contract/index.js';
import { StreakConfigNotSetError } from './streak.service.js';

const CONFIG_COLUMNS = {
  enabled: promoStreakConfig.enabled,
  dailyMinWager: promoStreakConfig.dailyMinWager,
  eligibleProducts: promoStreakConfig.eligibleProducts,
  rakebackMilestones: promoStreakConfig.rakebackMilestones,
  fixedRewards: promoStreakConfig.fixedRewards,
};

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

  async setConfig(adminId: Uuid, input: StreakConfig, meta?: Partial<ClientMeta>) {
    const config: StreakConfig = {
      ...input,
      eligibleProducts: [...new Set(input.eligibleProducts)],
    };
    return this.drizzle.db.transaction(async (tx) => {
      const [before] = await tx.select(CONFIG_COLUMNS).from(promoStreakConfig).for('update');
      await tx
        .insert(promoStreakConfig)
        .values({ ...config, currency: STREAK_CURRENCY, updatedBy: adminId })
        .onConflictDoUpdate({
          target: promoStreakConfig.singletonKey,
          set: { ...config, currency: STREAK_CURRENCY, updatedBy: adminId },
        });
      const switchedOn = config.enabled && !before?.enabled;
      const reset = switchedOn
        ? await tx
            .update(promoPlayerStreak)
            .set({ current: 0, lastQualifyingDay: null, updatedAt: sql`now()` })
            .where(gt(promoPlayerStreak.current, 0))
        : null;
      await this.audit.recordInTransaction(tx, {
        actorId: adminId,
        actorType: 'admin',
        action: 'promo.streak_config.set',
        resourceType: 'promo_streak_config',
        resourceId: null,
        before: before ?? null,
        after: { ...config, streaksReset: reset?.rowCount ?? 0 },
        ...meta,
      });
      return config;
    });
  }
}
