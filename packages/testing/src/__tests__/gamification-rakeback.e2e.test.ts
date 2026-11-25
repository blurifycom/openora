import { describe, it } from 'vitest';

describe('player rakeback', () => {
  it.todo(
    "a ranked player's bets accrue rakeback at the tier rate and the summary shows the unclaimed amount",
  );
  it.todo("an unranked player's bets accrue rakeback at the base rate");
  it.todo('an instant-mode accrual is credited to the wallet immediately and creates no claim');
  it.todo('claiming accrued rakeback credits the wallet once and marks the accruals claimed');
  it.todo('claiming twice returns nothing the second time and the wallet moves only once');
  it.todo('claiming with nothing accrued is refused or returns an empty paid list');
  it.todo('a suspended or closed account cannot claim rakeback');
  it.todo('a refunded or voided round reverses its accrual');
  it.todo("the rakeback summary of one player never includes another player's accruals");
  it.todo('claiming without a session is rejected as unauthorized');
});

describe('admin rakeback', () => {
  it.todo('an admin lists accruals and reads a player summary');
  it.todo('an admin voids an unclaimed accrual and the void is audited');
  it.todo('voiding an accrual that is already claimed is refused with a conflict');
  it.todo('voiding an unknown accrual returns not found');
  it.todo('the liability read totals unclaimed accruals per currency');
  it.todo('a non-admin calling any admin rakeback route is refused as forbidden');
});
