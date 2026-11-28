import { sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb, DrizzleTx } from '@openora/core/server';
import { DEFAULT_PAYMENT_PROVIDER } from '@openora/core/contracts';
import type { Wallet, WalletJobRun, WalletReconciliationFinding } from '../schema/index.js';

const TERMINAL_STATUSES = sql.raw(`('completed', 'failed', 'rejected', 'cancelled', 'refunded')`);

export const SWAP_DESK_PROVIDER_LABEL = 'swap-desk';

export const LEDGER_FINDING_LABEL = 'ledger';

const settledByHand = (kind: 'unknown_at_provider' | 'stuck_swap', defaultProvider: string) =>
  sql`exists (
  select 1 from wallet_reconciliation_finding f
  join wallet_transaction m on m.id = f.transaction_id
  where f.kind = ${kind} and f.status = 'resolved' and m.type = 'manual_credit'
    and m.wallet_id = t.wallet_id
    and f.provider_name = coalesce(t.provider_name, ${defaultProvider})
    and f.external_id in (t.provider_ref_id, t.id::text))`;

const moves = sql`case
  when t.type = 'deposit' then t.status = 'completed'
  when t.type = 'withdrawal' then t.status not in ('failed', 'rejected', 'cancelled', 'refunded')
    or ${settledByHand('unknown_at_provider', DEFAULT_PAYMENT_PROVIDER)}
  when t.type = 'swap_out' then t.status <> 'failed'
    or ${settledByHand('stuck_swap', SWAP_DESK_PROVIDER_LABEL)}
  else t.status = 'completed'
end`;

const credits = sql`(t.type = 'deposit'
  or (t.type not in ('withdrawal', 'swap_out') and t.direction = 'credit'))`;

const effect = sql`case
  when not (${moves}) then 0
  when ${credits} then coalesce(t.real_share, t.amount)
  else -coalesce(t.real_share, t.amount)
end`;

const unpriced = sql`(t.amount <> 0 and (${moves}) and (
  t.balance_after is null
  or (t.type not in ('deposit', 'withdrawal', 'swap_out') and t.direction is null)
  or (t.type = 'bet' and t.real_share is null and t.balance_after = 0
    and t.correction_requested_amount is null)))`;

const pairRows = sql`t.wallet_id = p.wallet_id and upper(t.currency) = p.currency`;

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

function ledgerAfter(asOf: SQL): SQL {
  return sql`(
    select coalesce(sum(${effect}), 0) as total, count(*) filter (where ${unpriced}) as unpriced
    from wallet_transaction t
    where ${pairRows} and (${asOf} is null or t.created_at > ${asOf}))`;
}

const latestBaseline = sql`(
  select bl.id, bl.amount, bl.as_of from wallet_balance_baseline bl
  where bl.wallet_id = p.wallet_id and bl.currency = p.currency
  order by bl.as_of desc, bl.created_at desc limit 1)`;

const BASELINE_GRACE = sql.raw(`interval '1 hour'`);

const cut = sql`least(now() - ${BASELINE_GRACE}, (
  select min(o.created_at) - interval '1 microsecond' from wallet_transaction o
  where o.wallet_id = p.wallet_id and upper(o.currency) = p.currency
    and o.status not in ${TERMINAL_STATUSES}))`;

function balancePage(afterId: string | null, limit: number): SQL {
  return sql`select b.id, b.wallet_id, b.currency, b.amount from wallet_balance b
    ${afterId === null ? sql`` : sql`where b.id > ${afterId}`}
    order by b.id limit ${limit}`;
}

export function ledgerPairKey(walletId: Wallet['id'], currency: string): string {
  return `wallet:${walletId}:${currency}`;
}

export function ledgerBreachKey(
  walletId: Wallet['id'],
  currency: string,
  baselineId: LedgerPairCheck['baselineId'],
  drift: string,
): string {
  return `${ledgerPairKey(walletId, currency)}:${baselineId ?? 'none'}:${drift}`;
}

export function ledgerUncheckedKey(
  walletId: Wallet['id'],
  currency: string,
  baselineId: LedgerPairCheck['baselineId'],
): string {
  return `${ledgerPairKey(walletId, currency)}:${baselineId ?? 'none'}`;
}

export function backfillMismatchKey(
  walletId: Wallet['id'],
  currency: string,
  drift: string,
): string {
  return `${ledgerPairKey(walletId, currency)}:backfill:${drift}`;
}

export function ledgerUncheckedDetail(
  pair: Pick<LedgerPairCheck, 'walletId' | 'currency' | 'balance' | 'unpricedRows'>,
): string {
  return `wallet ${pair.walletId} holds ${pair.unpricedRows} ${pair.currency} ledger rows nothing prices and no baseline covers them; run the baseline backfill (balance at filing: ${pair.balance})`;
}

const BALANCE_AT_FILING = /\(balance at filing: (-?\d+(?:\.\d+)?)\)$/;

export function parseBalanceAtFiling(detail: string | null): string | null {
  return (detail === null ? null : BALANCE_AT_FILING.exec(detail)?.[1]) ?? null;
}

const PAIR_KEY = /^wallet:([0-9a-f-]{36}):([^:]+)(?::|$)/;
const BREACH_KEY = /^wallet:[0-9a-f-]{36}:[^:]+:([0-9a-f-]{36}|none):(-?\d+(?:\.\d+)?)$/;

export function parseLedgerPairKey(
  externalId: string | null,
): { walletId: string; currency: string } | null {
  const match = externalId === null ? null : PAIR_KEY.exec(externalId);
  return match?.[1] && match[2] ? { walletId: match[1], currency: match[2] } : null;
}

export function parseLedgerBreachKey(
  externalId: string | null,
): { baselineId: LedgerPairCheck['baselineId']; drift: string } | null {
  const match = externalId === null ? null : BREACH_KEY.exec(externalId);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { baselineId: match[1] === 'none' ? null : match[1], drift: match[2] };
}

const UNCHECKED_KEY =
  /^wallet:[0-9a-f-]{36}:[^:]+:(?:([0-9a-f-]{36}|none)|backfill:(-?\d+(?:\.\d+)?))$/;

export function parseLedgerUncheckedKey(
  externalId: string | null,
): { baselineId: LedgerPairCheck['baselineId'] } | { backfillDrift: string } | null {
  const match = externalId === null ? null : UNCHECKED_KEY.exec(externalId);
  if (match?.[1]) {
    return { baselineId: match[1] === 'none' ? null : match[1] };
  }
  return match?.[2] ? { backfillDrift: match[2] } : null;
}

const breachKeyPrefix = sql`'wallet:' || c.wallet_id || ':' || c.currency || ':'
  || coalesce(c.baseline_id::text, 'none') || ':'`;

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
  baselineId: string | null;
  advancedTo: string | null;
};

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
    advanced_to: string | null;
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
      returning id, wallet_id, currency
    )
    select c.id, c.wallet_id, c.currency, c.balance, c.expected::text as expected,
      c.unpriced::text as unpriced_rows, c.baseline_id,
      (select adv.id from adv where adv.wallet_id = c.wallet_id and adv.currency = c.currency)
        as advanced_to
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
    advancedTo: row.advanced_to,
  }));
}

export type LedgerPairState = Pick<LedgerPairCheck, 'baselineId' | 'unpricedRows'> & {
  drift: string;
};

async function lockBalanceRow(txn: DrizzleTx, walletId: Wallet['id'], currency: string) {
  await txn.execute(sql`
    select 1 from wallet_balance
    where wallet_id = ${walletId} and currency = ${currency}
    for update`);
}

export async function lockAndCheckLedgerPair(
  txn: DrizzleTx,
  walletId: Wallet['id'],
  currency: string,
): Promise<LedgerPairState | null> {
  await lockBalanceRow(txn, walletId, currency);
  const { rows } = await txn.execute<{
    baseline_id: string | null;
    drift: string;
    unpriced: string;
  }>(sql`
    select c.baseline_id, (c.balance - c.expected)::text as drift, c.unpriced::text as unpriced
    from (${checkedPairs(sql`
      select b.id, b.wallet_id, b.currency, b.amount from wallet_balance b
      where b.wallet_id = ${walletId} and b.currency = ${currency}`)}) c`);
  const [row] = rows;
  return row
    ? { baselineId: row.baseline_id, drift: row.drift, unpricedRows: Number(row.unpriced) }
    : null;
}

export async function lockAndEstimateBackfill(
  txn: DrizzleTx,
  walletId: Wallet['id'],
  currency: string,
): Promise<{ baselineId: LedgerPairCheck['baselineId']; drift: string | null } | null> {
  await lockBalanceRow(txn, walletId, currency);
  const { rows } = await txn.execute<{ baseline_id: string | null; drift: string | null }>(sql`
    select bl.id as baseline_id, (p.amount - l.total - e.estimate)::text as drift
    from (
      select p.*, ${cut} as as_of from (
        select b.wallet_id, b.currency, b.amount from wallet_balance b
        where b.wallet_id = ${walletId} and b.currency = ${currency}) p) p
    cross join lateral ${ledgerAfter(sql`p.as_of`)} l
    left join lateral ${stampedEstimate(sql`p.as_of`)} e on true
    left join lateral ${latestBaseline} bl on true`);
  const [row] = rows;
  return row ? { baselineId: row.baseline_id, drift: row.drift } : null;
}

export type BackfillMismatch = {
  walletId: string;
  currency: string;
  amount: string;
  estimate: string;
};

const heldByBackfillMismatch = sql`exists (
  select 1 from wallet_reconciliation_finding f
  where f.kind = 'ledger_invariant_unchecked' and f.provider_name = ${LEDGER_FINDING_LABEL}
    and f.status = 'open'
    and starts_with(f.external_id, 'wallet:' || p.wallet_id || ':' || p.currency || ':backfill:'))`;

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

type BaselinePoint = { id: string; amount: string; asOf: string };

export type BaselineMove = {
  before: BaselinePoint | null;
  after: BaselinePoint;
  balance: string;
  estimate: string | null;
  mismatch: string | null;
};

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
