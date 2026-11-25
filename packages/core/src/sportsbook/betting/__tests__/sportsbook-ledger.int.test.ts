import { describe, it } from 'vitest';

describe('provider bet through the ledger', () => {
  it.todo(
    'reserve debits the stake from the player wallet and writes one bet row in the reserved state',
  );
  it.todo(
    'reserve with a stake above the available balance is refused and writes no ledger transaction',
  );
  it.todo('reserve for a restricted or closed player is refused');
  it.todo('confirm moves a reserved bet to confirmed and writes no second wallet movement');
  it.todo('cancel before confirm credits the stake back once');
  it.todo('a repeated cancel with the same request id credits nothing more');
});

describe('provider settle and void', () => {
  it.todo('settle a winning bet credits the payout once and marks the bet settled');
  it.todo('settle a losing bet writes a zero payout and no wallet credit');
  it.todo(
    'a repeated settle with the same fingerprint returns the stored outcome and writes nothing',
  );
  it.todo(
    'a settle with the same request id but a different payload is refused as a fingerprint mismatch',
  );
  it.todo('void restores the stake once and a second void changes nothing');
  it.todo('reopen of a settled bet reverses the payout and returns the bet to open');
  it.todo('settling a bet that was never reserved is refused');
  it.todo('a settle whose payout is negative or malformed is refused');
  it.todo('two concurrent settles of one bet credit the payout exactly once');
});

describe('stake resolution and promotions', () => {
  it.todo('the stake resolves from the bonus and real balance split of the reservation');
  it.todo(
    'a promotion payout outside the usual range raises a finding without blocking the payout',
  );
  it.todo(
    'a provider request without a status is treated as unknown and recorded for reconciliation, not applied',
  );
});

describe('reconciliation', () => {
  it.todo('reconciling a bet whose provider state differs from the ledger raises a finding');
  it.todo('reconciling a bet that matches the provider raises nothing');
  it.todo('running reconcile twice raises one finding per mismatch');
  it.todo(
    'a debt left by a settle after the wallet was drained is recorded and can be collected once',
  );
});
