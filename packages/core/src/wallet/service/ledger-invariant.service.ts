import { sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb, DrizzleTx } from '@openora/core/server';
import { DEFAULT_PAYMENT_PROVIDER } from '@openora/core/contracts';
import type { Wallet, WalletJobRun, WalletReconciliationFinding } from '../schema/index.js';

/**
 * The ledger invariant: per (wallet, currency), the balance a wallet holds equals its latest
 * baseline (zero when it has none) plus the real-balance effect of every ledger row after it.
 * Each statement below reads one snapshot, so a bet or win committing meanwhile is either wholly
 * in it (row and balance) or wholly out. Nothing here takes a lock or writes a balance; the only
 * writes are baseline rows, an append-only history whose latest `as_of` is the one in force.
 *
 * A row's effect, as the code that writes it moves the balance:
 * - deposit: +amount once `completed`; pending, failed, held and refunded ones never credited.
 * - withdrawal: -amount from the request on; `failed`/`rejected` put it back, except a failure
 *   an admin settled by hand with a manual credit to the same wallet (an `unknown_at_provider`
 *   finding resolved that way), which returns nothing because the manual credit row carries the
 *   money.
 * - swap_out: -amount from the request on; `failed` puts it back.
 * - anything else: only when `completed`, signed by `direction`, by `real_share` when set (a
 *   bonus-split bet, win or reversal moves the real balance by that part only) else `amount`.
 */
const TERMINAL_STATUSES = sql.raw(`('completed', 'failed', 'rejected', 'cancelled', 'refunded')`);

/** Findings the platform files about its own ledger, not about a vendor's report. */
export const LEDGER_FINDING_LABEL = 'ledger';

// The finding of an `unknown_at_provider` withdrawal is filed under the withdrawal's provider and
// reference, or its id when it had none yet (a reference may land after); resolving it overwrites
// the finding's transaction id with the manual credit, so the key is the only link back to the
// withdrawal.
const settledByHand = sql`exists (
  select 1 from wallet_reconciliation_finding f
  join wallet_transaction m on m.id = f.transaction_id
  where f.kind = 'unknown_at_provider' and f.status = 'resolved' and m.type = 'manual_credit'
    and m.wallet_id = t.wallet_id
    and f.provider_name = coalesce(t.provider_name, ${DEFAULT_PAYMENT_PROVIDER})
    and f.external_id in (t.provider_ref_id, t.id::text))`;

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

const pairRows = sql`t.wallet_id = p.wallet_id and upper(t.currency) = p.currency`;

/**
 * What the pair `p` held at `asOf` by the ledger's own stamps: the last `balance_after` of a row
 * that moved money at or before it, carried forward by the rows after that one. No row when
 * nothing was stamped.
 */
function stampedEstimate(asOf: SQL): SQL {
  return sql`(
    select r.balance_after + (
        select coalesce(sum(${effect}), 0) from wallet_transaction t
        where ${pairRows} and t.created_at <= ${asOf}
          and (t.created_at, t.id) > (r.created_at, r.id)) as estimate
    from (
      select t.created_at, t.id, t.balance_after from wallet_transaction t
      where ${pairRows} and t.created_at <= ${asOf} and t.balance_after is not null
        and (${moves})
      order by t.created_at desc, t.id desc limit 1) r)`;
}

/** Sum of effects and count of unpriced rows for the pair `p`, over rows after `asOf`. */
function ledgerAfter(asOf: SQL): SQL {
  return sql`(
    select coalesce(sum(${effect}), 0) as total, count(*) filter (where ${unpriced}) as unpriced
    from wallet_transaction t
    where ${pairRows} and (${asOf} is null or t.created_at > ${asOf}))`;
}

/** The baseline in force for the pair `p`: the latest one. */
const latestBaseline = sql`(
  select bl.id, bl.amount, bl.as_of from wallet_balance_baseline bl
  where bl.wallet_id = p.wallet_id and bl.currency = p.currency
  order by bl.as_of desc, bl.created_at desc limit 1)`;

// ponytail: assumes no wallet transaction stays uncommitted longer than this. One that did,
// started before the cut and committed after the snapshot, would land in neither the baseline
// nor the rows after it. A commit-ordered sequence on the ledger would remove the assumption.
const BASELINE_GRACE = sql.raw(`interval '1 hour'`);

// The latest point a baseline may sit at for the pair `p`: an hour back, and before its oldest
// row still in a non-terminal status, so every row at or before it is final and never moves
// money again.
const cut = sql`least(now() - ${BASELINE_GRACE}, (
  select min(o.created_at) - interval '1 microsecond' from wallet_transaction o
  where o.wallet_id = p.wallet_id and upper(o.currency) = p.currency
    and o.status not in ${TERMINAL_STATUSES}))`;

function balancePage(afterId: string | null, limit: number): SQL {
  return sql`select b.id, b.wallet_id, b.currency, b.amount from wallet_balance b
    ${afterId === null ? sql`` : sql`where b.id > ${afterId}`}
    order by b.id limit ${limit}`;
}

/** The finding key every ledger finding about one (wallet, currency) pair starts with. */
export function ledgerPairKey(walletId: Wallet['id'], currency: string): string {
  return `wallet:${walletId}:${currency}`;
}

/**
 * A breach is keyed on the baseline it was measured from and the drift, which play after it
 * leaves unchanged: a rerun files nothing new, while a further, different error does, and so
 * does the same error again once a clean check has moved the baseline on.
 */
export function ledgerBreachKey(
  walletId: Wallet['id'],
  currency: string,
  baselineId: LedgerPairCheck['baselineId'],
  drift: string,
): string {
  return `${ledgerPairKey(walletId, currency)}:${baselineId ?? 'none'}:${drift}`;
}

/**
 * A pair nothing can check yet, keyed on the baseline in force: a pair that is checked again
 * and later falls back to unchecked is filed anew, not matched to the closed finding.
 */
export function ledgerUncheckedKey(
  walletId: Wallet['id'],
  currency: string,
  baselineId: LedgerPairCheck['baselineId'],
): string {
  return `${ledgerPairKey(walletId, currency)}:${baselineId ?? 'none'}`;
}

/** A backfill whose amount disagrees with the balance the ledger last stamped. */
export function backfillMismatchKey(
  walletId: Wallet['id'],
  currency: string,
  drift: string,
): string {
  return `${ledgerPairKey(walletId, currency)}:backfill:${drift}`;
}

const PAIR_KEY = /^wallet:([0-9a-f-]{36}):([^:]+)(?::|$)/;
const BREACH_KEY = /^wallet:[0-9a-f-]{36}:[^:]+:([0-9a-f-]{36}|none):(-?\d+(?:\.\d+)?)$/;

/** The pair a ledger finding is about, read back from its key. */
export function parseLedgerPairKey(
  externalId: string | null,
): { walletId: string; currency: string } | null {
  const match = externalId === null ? null : PAIR_KEY.exec(externalId);
  return match?.[1] && match[2] ? { walletId: match[1], currency: match[2] } : null;
}

/** The baseline a breach was measured from and its signed drift, read back from its key. */
export function parseLedgerBreachKey(
  externalId: string | null,
): { baselineId: LedgerPairCheck['baselineId']; drift: string } | null {
  const match = externalId === null ? null : BREACH_KEY.exec(externalId);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { baselineId: match[1] === 'none' ? null : match[1], drift: match[2] };
}

// Same shape as `ledgerBreachKey`, built in SQL for the pair `c`.
const breachKeyPrefix = sql`'wallet:' || c.wallet_id || ':' || c.currency || ':'
  || coalesce(c.baseline_id::text, 'none') || ':'`;

/** Each pair of `pairs` beside its baseline in force and what its ledger adds up to from it. */
function checkedPairs(pairs: SQL): SQL {
  return sql`select p.id, p.wallet_id, p.currency, p.amount as balance, bl.id as baseline_id,
      bl.as_of as base_as_of, coalesce(bl.amount, 0) + l.total as expected, l.unpriced,
      ${cut} as cut
    from (${pairs}) p
    left join lateral ${latestBaseline} bl on true
    cross join lateral ${ledgerAfter(sql`bl.as_of`)} l`;
}

export type LedgerPairCheck = {
  id: string;
  walletId: string;
  currency: string;
  balance: string;
  expected: string;
  unpricedRows: number;
  /** The baseline `expected` starts from, null when the pair has none. */
  baselineId: string | null;
  /** The check came out clean and moved the pair's baseline to the cut. */
  advanced: boolean;
};

/**
 * One page of wallet balances, each beside what its ledger adds up to. A pair that comes out
 * clean has its baseline moved to the cut, priced from the ledger alone (the old baseline plus
 * the rows up to the cut), never from the balance: the rows it absorbs are final and were just
 * shown to add up. It moves only when there is something to absorb, or when a breach was filed
 * against the baseline in force, so the same error coming back later is filed again.
 */
export async function checkLedgerPage(
  db: DrizzleDb,
  afterId: string | null,
  limit: number,
  runId: WalletJobRun['runId'],
): Promise<LedgerPairCheck[]> {
  const { rows } = await db.execute<{
    id: string;
    wallet_id: string;
    currency: string;
    balance: string;
    expected: string;
    unpriced_rows: string;
    baseline_id: string | null;
    advanced: boolean;
  }>(sql`
    with p as (${balancePage(afterId, limit)}),
    c as (${checkedPairs(sql`select * from p`)}),
    adv as (
      insert into wallet_balance_baseline (wallet_id, currency, amount, as_of, run_id)
      select c.wallet_id, c.currency, c.expected - a.total, c.cut, ${runId}
      from c cross join lateral (
        select coalesce(sum(${effect}), 0) as total from wallet_transaction t
        where t.wallet_id = c.wallet_id and upper(t.currency) = c.currency
          and t.created_at > c.cut) a
      where c.unpriced = 0 and c.balance = c.expected
        and (c.base_as_of is null or c.cut > c.base_as_of)
        and (exists (
            select 1 from wallet_transaction t
            where t.wallet_id = c.wallet_id and upper(t.currency) = c.currency
              and (c.base_as_of is null or t.created_at > c.base_as_of) and t.created_at <= c.cut)
          or exists (
            select 1 from wallet_reconciliation_finding f
            where f.kind = 'ledger_invariant_breach' and f.provider_name = ${LEDGER_FINDING_LABEL}
              and starts_with(f.external_id, ${breachKeyPrefix})))
      returning wallet_id, currency
    )
    select c.id, c.wallet_id, c.currency, c.balance, c.expected::text as expected,
      c.unpriced::text as unpriced_rows, c.baseline_id,
      exists (select 1 from adv where adv.wallet_id = c.wallet_id and adv.currency = c.currency)
        as advanced
    from c
    order by c.id`);
  return rows.map((row) => ({
    id: row.id,
    walletId: row.wallet_id,
    currency: row.currency,
    balance: row.balance,
    expected: row.expected,
    unpricedRows: Number(row.unpriced_rows),
    baselineId: row.baseline_id,
    advanced: row.advanced,
  }));
}

export type LedgerPairState = Pick<LedgerPairCheck, 'baselineId' | 'unpricedRows'> & {
  /** Balance less what the ledger adds up to, signed. */
  drift: string;
};

/**
 * One pair checked now, as a run checks it, for an admin resolving a finding about it. Locks the
 * pair's balance row until the caller's transaction ends, so nothing moves the drift between
 * this check and what the resolution does about it. Null when the pair holds no balance.
 */
export async function lockAndCheckLedgerPair(
  txn: DrizzleTx,
  walletId: Wallet['id'],
  currency: string,
): Promise<LedgerPairState | null> {
  const { rows } = await txn.execute<{
    baseline_id: string | null;
    drift: string;
    unpriced: string;
  }>(sql`
    select c.baseline_id, (c.balance - c.expected)::text as drift, c.unpriced::text as unpriced
    from (${checkedPairs(sql`
      select b.id, b.wallet_id, b.currency, b.amount from wallet_balance b
      where b.wallet_id = ${walletId} and b.currency = ${currency}
      for update`)}) c`);
  const [row] = rows;
  return row
    ? { baselineId: row.baseline_id, drift: row.drift, unpricedRows: Number(row.unpriced) }
    : null;
}

export type BackfillMismatch = {
  walletId: string;
  currency: string;
  amount: string;
  estimate: string;
};

// A pair whose backfill was flagged stays unbaselined until a super admin resolves the finding: a
// later stamp written off the wrong balance would otherwise agree with it and make it the zero.
const heldByBackfillMismatch = sql`exists (
  select 1 from wallet_reconciliation_finding f
  where f.kind = 'ledger_invariant_unchecked' and f.provider_name = ${LEDGER_FINDING_LABEL}
    and f.status = 'open'
    and starts_with(f.external_id, 'wallet:' || p.wallet_id || ':' || p.currency || ':backfill:'))`;

/**
 * Baselines one page of (wallet, currency) pairs whose history holds an unpriced row and that
 * have no baseline yet, at the cut. A pair with an unpriced row after the cut cannot be
 * baselined and is counted as skipped. The amount (the balance less every row after the cut)
 * is cross-checked against the last `balance_after` the ledger stamped at or before the cut,
 * carried forward by the rows between: a pair where the two disagree is returned as a mismatch
 * and not baselined, because a baseline over a wallet already wrong makes its error the new zero.
 * Inserts only; a pair already baselined, or held by a mismatch still open, is left as it is.
 */
export async function backfillBaselinePage(
  db: DrizzleDb,
  afterId: string | null,
  limit: number,
  runId: WalletJobRun['runId'],
): Promise<{
  lastId: string | null;
  scanned: number;
  inserted: number;
  skipped: number;
  mismatches: BackfillMismatch[];
}> {
  const { rows } = await db.execute<{
    id: string;
    wallet_id: string;
    currency: string;
    amount: string | null;
    estimate: string | null;
    unpriced: string | null;
    inserted: boolean;
  }>(sql`
    with p as (${balancePage(afterId, limit)}),
    needs as (
      select p.*, ${cut} as as_of
      from p
      where not exists (
          select 1 from wallet_balance_baseline bl
          where bl.wallet_id = p.wallet_id and bl.currency = p.currency)
        and exists (select 1 from wallet_transaction t where ${pairRows} and ${unpriced})
        and not ${heldByBackfillMismatch}
    ),
    priced as (
      select p.id, p.wallet_id, p.currency, p.amount - l.total as amount, p.as_of, l.unpriced,
        e.estimate
      from needs p
      cross join lateral ${ledgerAfter(sql`p.as_of`)} l
      left join lateral ${stampedEstimate(sql`p.as_of`)} e on true
    ),
    ins as (
      insert into wallet_balance_baseline (wallet_id, currency, amount, as_of, run_id)
      select wallet_id, currency, amount, as_of, ${runId} from priced
      where unpriced = 0 and (estimate is null or estimate = amount)
      returning wallet_id, currency
    )
    select p.id, p.wallet_id, p.currency, pr.amount::text as amount,
      pr.estimate::text as estimate, pr.unpriced::text as unpriced,
      exists (select 1 from ins where ins.wallet_id = p.wallet_id and ins.currency = p.currency)
        as inserted
    from p left join priced pr on pr.id = p.id
    order by p.id`);
  const mismatches: BackfillMismatch[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (row.unpriced === null || row.amount === null) {
      continue;
    }
    if (Number(row.unpriced) > 0) {
      skipped += 1;
    } else if (!row.inserted && row.estimate !== null) {
      mismatches.push({
        walletId: row.wallet_id,
        currency: row.currency,
        amount: row.amount,
        estimate: row.estimate,
      });
    }
  }
  return {
    lastId: rows.at(-1)?.id ?? null,
    scanned: rows.length,
    inserted: rows.filter((row) => row.inserted).length,
    skipped,
    mismatches,
  };
}

export type BaselinePoint = { id: string; amount: string; asOf: string };

export type BaselineMove = {
  before: BaselinePoint | null;
  after: BaselinePoint;
  balance: string;
  /** What the ledger's own stamps carry forward to at the new baseline, null when none. */
  estimate: string | null;
  /** The new baseline less that estimate: what the re-baseline vouches for beyond the stamps. */
  mismatch: string | null;
};

/**
 * Re-baselines one pair at the balance it holds now, for a super admin resolving a ledger
 * finding against it: the new baseline sits at the cut (never before the one in force) at the
 * balance less every row after it, linked to the finding, beside the backfill's cross-check
 * against the ledger's stamps for the record. Null when a row after the cut is unpriced, so
 * nothing could be baselined.
 */
export async function rebaselinePair(
  db: DrizzleDb | DrizzleTx,
  walletId: Wallet['id'],
  currency: string,
  findingId: WalletReconciliationFinding['id'],
): Promise<BaselineMove | null> {
  const { rows } = await db.execute<{
    prior_id: string | null;
    prior_amount: string | null;
    prior_as_of: string | null;
    id: string;
    amount: string;
    as_of: string;
    balance: string;
    estimate: string | null;
    mismatch: string | null;
  }>(sql`
    with p as (
      select b.wallet_id, b.currency, b.amount from wallet_balance b
      where b.wallet_id = ${walletId} and b.currency = ${currency}
    ),
    c as (
      select p.*, bl.id as prior_id, bl.amount as prior_amount, bl.as_of as prior_as_of,
        greatest(bl.as_of, ${cut}) as as_of
      from p left join lateral ${latestBaseline} bl on true
    ),
    ins as (
      insert into wallet_balance_baseline (wallet_id, currency, amount, as_of, finding_id)
      select p.wallet_id, p.currency, p.amount - l.total, p.as_of, ${findingId}
      from c p cross join lateral ${ledgerAfter(sql`p.as_of`)} l
      where l.unpriced = 0
      returning id, amount, as_of
    )
    select p.prior_id, p.prior_amount::text as prior_amount, p.prior_as_of::text as prior_as_of,
      ins.id, ins.amount::text as amount, ins.as_of::text as as_of, p.amount::text as balance,
      e.estimate::text as estimate, (ins.amount - e.estimate)::text as mismatch
    from c p cross join ins
    left join lateral ${stampedEstimate(sql`p.as_of`)} e on true`);
  const [row] = rows;
  if (!row) {
    return null;
  }
  return {
    before:
      row.prior_id !== null && row.prior_amount !== null && row.prior_as_of !== null
        ? { id: row.prior_id, amount: row.prior_amount, asOf: row.prior_as_of }
        : null,
    after: { id: row.id, amount: row.amount, asOf: row.as_of },
    balance: row.balance,
    estimate: row.estimate,
    mismatch: row.mismatch,
  };
}
