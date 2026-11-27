import { between } from 'drizzle-orm';
import type { CacheAdapter, MoneyReportingPort } from '@openora/core/contracts';
import { DrizzleService } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { FUNNEL_STAGES, type ConversionFunnel, type FunnelQuery } from '../contract/index.js';

const ANALYTICS_CACHE_TTL_MS = 60_000;
const DEFAULT_FUNNEL_RANGE_DAYS = 30;

function resolveFunnelRange(dateFrom?: string, dateTo?: string): { from: Date; to: Date } {
  const to = dateTo ? new Date(dateTo) : new Date();
  const from = dateFrom
    ? new Date(dateFrom)
    : new Date(to.getTime() - DEFAULT_FUNNEL_RANGE_DAYS * 24 * 60 * 60 * 1000);
  return { from, to };
}

export function dropOffRate(previous: number, current: number): number {
  if (previous === 0) {
    return 0;
  }
  return (previous - current) / previous;
}

export class FunnelAnalyticsService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly cache: CacheAdapter,
    private readonly reporting: MoneyReportingPort,
  ) {}

  async conversion(query: FunnelQuery): Promise<ConversionFunnel> {
    const key = `analytics:funnel.conversion:${JSON.stringify(query, Object.keys(query).sort())}`;
    const cached = await this.cache.get<ConversionFunnel>(key);
    if (cached !== undefined) {
      return cached;
    }
    const value = await this.computeConversion(query);
    await this.cache.set(key, value, { ttlMs: ANALYTICS_CACHE_TTL_MS });
    return value;
  }

  private async computeConversion({ dateFrom, dateTo }: FunnelQuery): Promise<ConversionFunnel> {
    const range = resolveFunnelRange(dateFrom, dateTo);

    const registered = await this.drizzle.db
      .select({ id: user.id, emailVerified: user.emailVerified })
      .from(user)
      .where(between(user.createdAt, range.from, range.to));
    const verified = registered.filter((row) => row.emailVerified).map((row) => row.id);
    const activity = await this.reporting.funnelActivity(verified);
    const deposited = new Set(activity.deposited);
    const placedBet = new Set(activity.placedBet);
    const counts = {
      registered: registered.length,
      email_verified: verified.length,
      first_deposit: verified.filter((id) => deposited.has(id)).length,
      first_bet: verified.filter((id) => deposited.has(id) && placedBet.has(id)).length,
    };

    return FUNNEL_STAGES.map((stage, index) => {
      const previousStage = FUNNEL_STAGES[index - 1];
      return {
        stage,
        count: counts[stage],
        dropOffRate: previousStage ? dropOffRate(counts[previousStage], counts[stage]) : null,
      };
    });
  }
}
