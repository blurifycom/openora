import { describe, it } from 'vitest';

describe('KYC global switch and withdrawal gate', () => {
  it.todo(
    'admin turns the global KYC switch off and a player with deposits over the threshold withdraws without KYC',
  );
  it.todo(
    'admin turns the global KYC switch on and the same player is blocked from withdrawing until approved',
  );
  it.todo('player whose cumulative completed deposits stay at the threshold withdraws without KYC');
  it.todo(
    'player whose cumulative deposits exceed the threshold in the pivot currency is refused a withdrawal with a KYC-required error',
  );
  it.todo(
    'deposits in several currencies are summed in the pivot currency before the threshold check',
  );
  it.todo(
    'a deposit currency that cannot be priced into the pivot currency makes the withdrawal require KYC',
  );
  it.todo(
    'a withdrawal above the single-withdrawal threshold requires KYC even with deposits under the cumulative threshold',
  );
  it.todo(
    'player approved on basic KYC withdraws again and the block is lifted without admin action',
  );
  it.todo('player with a declined KYC decision stays blocked from withdrawing');
  it.todo('a blocked withdrawal creates no ledger row and leaves the balance unchanged');
  it.todo('player cannot read or change the global KYC configuration through the admin route');
  it.todo(
    'admin updates the global KYC configuration with a stale version and gets a version conflict',
  );
});

describe('Actions that need basic KYC', () => {
  it.todo('player without basic KYC cannot send a gift and nothing is debited');
  it.todo('player without basic KYC cannot send a rain or donate and gets a KYC-required error');
  it.todo('player without basic KYC cannot join or create a PvP match');
  it.todo('player with approved basic KYC can gift, rain, donate and join PvP');
  it.todo('approval of basic KYC lifts the block on the next request without a new session');
  it.todo('a player with KYC pending is treated as unverified for gift, rain, donate and PvP');
  it.todo(
    'with the global KYC switch off the gift, rain, donate and PvP actions do not require KYC',
  );
});

describe('Country KYC exemption', () => {
  it.todo('player registering from a country with no KYC requirement is approved at registration');
  it.todo('exempt player withdraws over the cumulative threshold without submitting documents');
  it.todo('player registering from a country that requires KYC starts as not started');
  it.todo(
    'admin exempting a country applies the exemption to existing players of that country and audits it',
  );
  it.todo('admin without the compliance permission cannot change a country rule');
});
