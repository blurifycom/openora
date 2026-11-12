import { sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '@openora/core/server';

/**
 * The ledger invariant: per (wallet, currency), the balance a wallet holds equals its baseline
 * (zero when it has none) plus the real-balance effect of every ledger row after it. Each
 * statement below reads one snapshot, so a bet or win committing meanwhile is either wholly in
 * it (row and balance) or wholly out. Nothing here takes a lock or writes a balance.
 *
 * A row's effect, as the code that writes it moves the balance:
 * - deposit: +amount once `completed`; pending, failed, held and refunded ones never credited.
 * - withdrawal: -amount from the request on; `failed`/`rejected` put it back, except a failure
 *   an admin settled by hand with a manual credit (an `unknown_at_provider` finding resolved
 *   that way), which returns nothing because the manual credit row carries the money.
 * - swap_out: -amount from the request on; `failed` puts it back.
 * - anything else: only when `completed`, signed by `direction`, by `real_share` when set (a
 *   bonus-split bet, win or reversal moves the real balance by that part only) else `amount`.
 */
const TERMINAL_STATUSES = sql.raw(`('completed', 'failed', 'rejected', 'cancelled', 'refunded')`);

const settledByHand = sql`exists (
  select 1 from wallet_reconciliation_finding f
  join wallet_transaction m on m.id = f.transaction_id
  where f.kind = 'unknown_at_provider' and f.status = 'resolved' and m.type = 'manual_credit'
    and f.external_id in (t.id::text, t.provider_ref_id))`;

const moves = sql`case
  when t.type = 'deposit' then t.status = 'completed'
  when t.type = 'withdrawal' then t.status not in ('failed', 'rejected', 'cancelled', 'refunded')
    or ${settledByHand}
  when t.type = 'swap_out' then t.status <> 'failed'
  else t.status = 'completed'
end`;

const credits = sql`(t.type = 'deposit'
  or (t.type not in ('withdrawal', 'swap_out') and t.direction = 'credit'))`;

const effect = sql`case
  when not (${moves}) then 0
  when ${credits} then coalesce(t.real_share, t.amount)
  else -coalesce(t.real_share, t.amount)
end`;

// A row that moved money by an amount nothing on it records: written before `balance_after`
// (and with it a win's `real_share`), before `direction`, or a bet from before bets recorded
// their real part that emptied the balance (it may have been bonus-split). A correction's `bet`
// re-collects from the real balance only, so emptying it says nothing about a bonus split.
const unpriced = sql`(t.amount <> 0 and (${moves}) and (
  t.balance_after is null
  or (t.type not in ('deposit', 'withdrawal', 'swap_out') and t.direction is null)
  or (t.type = 'bet' and t.real_share is null and t.balance_after = 0
    and t.correction_requested_amount is null)))`;

/** Sum of effects and count of unpriced rows for the pair `p`, over rows after `asOf`. */
function ledgerAfter(asOf: SQL): SQL {
  return sql`(
    select coalesce(sum(${effect}), 0) as total, count(*) filter (where ${unpriced}) as unpriced
    from wallet_transaction t
    where t.wallet_id = p.wallet_id and upper(t.currency) = p.currency
      and (${asOf} is null or t.created_at > ${asOf}))`;
}

function balancePage(afterId: string | null, limit: number): SQL {
  return sql`select b.id, b.wallet_id, b.currency, b.amount from wallet_balance b
    ${afterId === null ? sql`` : sql`where b.id > ${afterId}`}
    order by b.id limit ${limit}`;
}

export type LedgerPairCheck = {
  id: string;
  walletId: string;
  currency: string;
  balance: string;
  expected: string;
  unpricedRows: number;
};

/** One page of wallet balances, each beside what its ledger adds up to. */
export async function checkLedgerPage(
  db: DrizzleDb,
  afterId: string | null,
  limit: number,
): Promise<LedgerPairCheck[]> {
  const { rows } = await db.execute<{
    id: string;
    wallet_id: string;
    currency: string;
    balance: string;
    expected: string;
    unpriced_rows: string;
  }>(sql`
    with p as (${balancePage(afterId, limit)})
    select p.id, p.wallet_id, p.currency, p.amount as balance,
      (coalesce(bl.amount, 0) + l.total)::text as expected, l.unpriced::text as unpriced_rows
    from p
    left join wallet_balance_baseline bl on bl.wallet_id = p.wallet_id and bl.currency = p.currency
    cross join lateral ${ledgerAfter(sql`bl.as_of`)} l
    order by p.id`);
  return rows.map((row) => ({
    id: row.id,
    walletId: row.wallet_id,
    currency: row.currency,
    balance: row.balance,
    expected: row.expected,
    unpricedRows: Number(row.unpriced_rows),
  }));
}

// ponytail: assumes no wallet transaction stays uncommitted longer than this. One that did,
// started before the cut and committed after the snapshot, would land in neither the baseline
// nor the rows after it. A commit-ordered sequence on the ledger would remove the assumption.
const BASELINE_GRACE = sql.raw(`interval '1 hour'`);

/**
 * Baselines one page of (wallet, currency) pairs whose history holds an unpriced row and that
 * have no baseline yet. The cut sits an hour back, and before the pair's oldest row still in a
 * non-terminal status, so every row at or before it is final and can never move money again.
 * A pair with an unpriced row after that cut cannot be baselined and is counted as skipped.
 * Inserts only; a pair already baselined is left as it is, so a rerun changes nothing.
 */
export async function backfillBaselinePage(
  db: DrizzleDb,
  afterId: string | null,
  limit: number,
): Promise<{ lastId: string | null; scanned: number; inserted: number; skipped: number }> {
  const { rows } = await db.execute<{
    last_id: string | null;
    scanned: number;
    inserted: number;
    skipped: number;
  }>(sql`
    with p as (${balancePage(afterId, limit)}),
    needs as (
      select p.*, least(now() - ${BASELINE_GRACE}, (
          select min(o.created_at) - interval '1 microsecond' from wallet_transaction o
          where o.wallet_id = p.wallet_id and upper(o.currency) = p.currency
            and o.status not in ${TERMINAL_STATUSES})) as as_of
      from p
      where not exists (
          select 1 from wallet_balance_baseline bl
          where bl.wallet_id = p.wallet_id and bl.currency = p.currency)
        and exists (
          select 1 from wallet_transaction t
          where t.wallet_id = p.wallet_id and upper(t.currency) = p.currency and ${unpriced})
    ),
    priced as (
      select p.wallet_id, p.currency, p.amount - l.total as amount, p.as_of, l.unpriced
      from needs p cross join lateral ${ledgerAfter(sql`p.as_of`)} l
    ),
    ins as (
      insert into wallet_balance_baseline (wallet_id, currency, amount, as_of)
      select wallet_id, currency, amount, as_of from priced where unpriced = 0
      on conflict (wallet_id, currency) do nothing
      returning 1
    )
    select (select id from p order by id desc limit 1) as last_id,
      (select count(*)::int from p) as scanned,
      (select count(*)::int from ins) as inserted,
      (select count(*)::int from priced where unpriced > 0) as skipped`);
  const [row] = rows;
  return {
    lastId: row?.last_id ?? null,
    scanned: row?.scanned ?? 0,
    inserted: row?.inserted ?? 0,
    skipped: row?.skipped ?? 0,
  };
}
