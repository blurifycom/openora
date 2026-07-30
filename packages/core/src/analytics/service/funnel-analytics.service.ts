import { sql } from 'drizzle-orm';
import type { CacheAdapter } from '@openora/core/contracts';
import { DrizzleService } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
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

function dropOffRate(previous: number, current: number): number {
  if (previous === 0) {
    return 0;
  }
  return (previous - current) / previous;
}

export class FunnelAnalyticsService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly cache: CacheAdapter,
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

    const result = await this.drizzle.db.execute<{
      registered: string;
      email_verified: string;
      first_deposit: string;
      first_bet: string;
    }>(sql`
      with deposited as (
        select distinct ${wallet.userId} as user_id
        from ${walletTransaction}
        inner join ${wallet} on ${wallet.id} = ${walletTransaction.walletId}
        where ${walletTransaction.type} = 'deposit' and ${walletTransaction.status} = 'completed'
      ),
      placed_bet as (
        select distinct ${wallet.userId} as user_id
        from ${walletTransaction}
        inner join ${wallet} on ${wallet.id} = ${walletTransaction.walletId}
        where ${walletTransaction.type} = 'bet' and ${walletTransaction.status} = 'completed'
      )
      select
        count(*) as registered,
        count(*) filter (where ${user.emailVerified}) as email_verified,
        count(*) filter (where ${user.emailVerified} and deposited.user_id is not null) as first_deposit,
        count(*) filter (
          where ${user.emailVerified}
            and deposited.user_id is not null
            and placed_bet.user_id is not null
        ) as first_bet
      from ${user}
      left join deposited on deposited.user_id = ${user.id}
      left join placed_bet on placed_bet.user_id = ${user.id}
      where ${user.createdAt} between ${range.from} and ${range.to}
    `);

    const row = result.rows[0];
    const counts = {
      registered: Number(row?.registered ?? 0),
      email_verified: Number(row?.email_verified ?? 0),
      first_deposit: Number(row?.first_deposit ?? 0),
      first_bet: Number(row?.first_bet ?? 0),
    };

    console.log(
      'FUNNEL_SRV',
      JSON.stringify({ row, counts, stages: FUNNEL_STAGES, len: FUNNEL_STAGES.length }),
    );
    return FUNNEL_STAGES.map((stage, index) => {
      const previousStage = FUNNEL_STAGES[index - 1];
      return {
        stage,
        count: counts[stage],
        dropOffRate: previousStage ? dropOffRate(counts[previousStage], counts[stage]) : 0,
      };
    });
  }
}
