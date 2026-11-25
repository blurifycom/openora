import { describe, it } from 'vitest';

describe('reconciliation and stuck withdrawals', () => {
  it.todo(
    'an admin running reconciliation gets a run id and findings for a deposit the vendor reports and the ledger lacks',
  );
  it.todo('an admin listing findings filters by kind and status and pages them');
  it.todo(
    'an admin resolving a finding as credited, released, refunded, dismissed or rebaselined writes an audit row and applies once',
  );
  it.todo('resolving an already resolved finding is refused');
  it.todo('a withdrawal stuck without a vendor result is detected and flagged for an admin');
  it.todo(
    'the ledger invariant check reports a wallet whose balance differs from the sum of its ledger rows',
  );
  it.todo('a non-admin running or resolving reconciliation is refused with 403');
});

describe('custody sweep', () => {
  it.todo(
    'an admin triggering a sweep gets a run id and the sweep moves only funds above the gate',
  );
  it.todo('a sweep does not run while the sweep gate is closed');
  it.todo('a sweep triggered twice at once runs once');
  it.todo('a non-admin triggering a sweep is refused with 403');
});
