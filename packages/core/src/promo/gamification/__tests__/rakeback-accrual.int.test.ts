import { describe, it } from 'vitest';

describe('rakeback accrual and payout', () => {
  it.todo('a settled bet accrues rakeback at the ranked rate for a ranked player');
  it.todo('a settled bet accrues rakeback at the unranked rate for an unranked player');
  it.todo(
    'an instant accrual credits the wallet in the same transaction and leaves no claimable row',
  );
  it.todo('a claimable accrual stays open until claimed');
  it.todo('a round reversal removes the accrual it created and a repeated reversal does nothing');
  it.todo('an accrual with an unavailable payout rate is held and not lost');
  it.todo('a player closed or suspended is skipped by the automatic payout');
});

describe('race payout', () => {
  it.todo('closing a race pays each prize position once to the matching player');
  it.todo('a race without a bonus records positions and creates no grant');
  it.todo('a race closed twice pays nothing the second time');
  it.todo('a position with no player is skipped without failing the close');
});
