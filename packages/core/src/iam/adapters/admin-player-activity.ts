import type {
  ActiveUsersTrendPoint,
  AdminPlayerActivity,
  PlayerActivityFilter,
  RegistrationsOverTimePoint,
  RetentionCohortRow,
} from '@openora/core/contracts';
import { DrizzleService } from '@openora/core/server';
import { sql } from 'drizzle-orm';
// Read-only cross-domain read of the user/session tables via the public /schema
// subpath (allowed per ADR-0020/0025) - iam already depends on identity (plugin.ts),
// which owns these tables. Mirrors how identity's DrizzleAdminUserDirectory reads
// the profile module's `player` table.
import { session, user } from '@openora/core/pam/schema/identity';

const DEFAULT_RANGE_DAYS = 30;

function resolveRange(filter: PlayerActivityFilter): { from: Date; to: Date } {
  const to = filter.dateTo ?? new Date();
  const from = filter.dateFrom ?? new Date(to.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  return { from, to };
}

export class DrizzleAdminPlayerActivity implements AdminPlayerActivity {
  constructor(private readonly drizzle: DrizzleService) {}

  async getRegistrationsOverTime(
    filter: PlayerActivityFilter,
  ): Promise<RegistrationsOverTimePoint[]> {
    const { from, to } = resolveRange(filter);
    const result = await this.drizzle.db.execute<{ date: string; registrations: string }>(sql`
      select gs::date::text as date, count(${user.id})::int as registrations
      from generate_series(${from}::date, ${to}::date, interval '1 day') as gs
      left join ${user} on date_trunc('day', ${user.createdAt}) = gs
      group by gs
      order by gs
    `);
    return result.rows.map((r) => ({ date: r.date, registrations: Number(r.registrations) }));
  }

  // "Active" = a session row whose `updatedAt` falls in the trailing window. Chosen over
  // `createdAt` because better-auth refreshes a session's `updatedAt` on continued use
  // (schema/index.ts `$onUpdateFn`), so it approximates ongoing activity across the
  // session's lifetime; `createdAt` would only capture the single login moment. This is
  // the same "active" definition reused below for retention's "has a session row" check.
  async getActiveUsersTrend(filter: PlayerActivityFilter): Promise<ActiveUsersTrendPoint[]> {
    const { from, to } = resolveRange(filter);
    // A single join bounded by the widest (MAU) window, then FILTER narrows the
    // distinct-user count per day - one pass over `session` instead of three
    // correlated subqueries re-scanning it for every generated day.
    const result = await this.drizzle.db.execute<{
      date: string;
      dau: string;
      wau: string;
      mau: string;
    }>(sql`
      select
        gs::date::text as date,
        count(distinct ${session.userId}) filter (
          where ${session.updatedAt} >= gs and ${session.updatedAt} < gs + interval '1 day'
        ) as dau,
        count(distinct ${session.userId}) filter (
          where ${session.updatedAt} >= gs - interval '6 days'
            and ${session.updatedAt} < gs + interval '1 day'
        ) as wau,
        count(distinct ${session.userId}) filter (
          where ${session.updatedAt} >= gs - interval '29 days'
            and ${session.updatedAt} < gs + interval '1 day'
        ) as mau
      from generate_series(${from}::date, ${to}::date, interval '1 day') as gs
      left join ${session}
        on ${session.updatedAt} >= gs - interval '29 days'
        and ${session.updatedAt} < gs + interval '1 day'
      group by gs
      order by gs
    `);
    return result.rows.map((r) => ({
      date: r.date,
      dau: Number(r.dau),
      wau: Number(r.wau),
      mau: Number(r.mau),
    }));
  }

  async getRetentionCohorts(
    filter: PlayerActivityFilter,
    windowDays: 7 | 30,
  ): Promise<RetentionCohortRow[]> {
    const { from, to } = resolveRange(filter);
    const result = await this.drizzle.db.execute<{
      cohort_date: string;
      cohort_size: string;
      returned: string;
      is_complete: boolean;
    }>(sql`
      with cohort_users as (
        select ${user.id} as user_id, date_trunc('day', ${user.createdAt}) as cohort_date
        from ${user}
        where ${user.createdAt} >= ${from} and ${user.createdAt} <= ${to}
      ),
      returned_users as (
        select distinct cu.user_id
        from cohort_users cu
        inner join ${session}
          on ${session.userId} = cu.user_id
          and ${session.updatedAt} >= cu.cohort_date + interval '1 day'
          and ${session.updatedAt} <= cu.cohort_date + interval '1 day' * ${windowDays}
      )
      select
        cu.cohort_date::date::text as cohort_date,
        count(cu.user_id) as cohort_size,
        count(ru.user_id) as returned,
        (cu.cohort_date + interval '1 day' * ${windowDays} <= now()) as is_complete
      from cohort_users cu
      left join returned_users ru on ru.user_id = cu.user_id
      group by cu.cohort_date
      order by cu.cohort_date
    `);
    return result.rows.map((r) => {
      const cohortSize = Number(r.cohort_size);
      const returned = Number(r.returned);
      return {
        cohortDate: r.cohort_date,
        cohortSize,
        returned,
        returnRate: cohortSize > 0 ? returned / cohortSize : 0,
        isComplete: r.is_complete,
      };
    });
  }
}
