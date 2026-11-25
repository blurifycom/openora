import { describe, it } from 'vitest';

describe('admin withdrawal queue decisions', () => {
  it.todo('an admin listing the withdrawal queue sees waiting withdrawals filtered and summarised');
  it.todo('an admin approving a waiting withdrawal pays it out once and the ledger row completes');
  it.todo(
    'approving the same withdrawal twice pays once and the second call is refused as not pending',
  );
  it.todo(
    'an admin rejecting a waiting withdrawal with a reason refunds the full amount once and writes the audit row',
  );
  it.todo(
    'rejecting the same withdrawal twice refunds once and the second call is refused as not pending',
  );
  it.todo('rejecting a withdrawal after it was approved is refused and refunds nothing');
  it.todo('approving a withdrawal while two admins race on it pays once');
  it.todo('approving or rejecting a withdrawal that does not exist answers not found');
  it.todo(
    'a player or an admin without the withdrawal permission calling approve or reject is refused with 403',
  );
  it.todo('an unauthenticated caller calling approve, reject or list is refused with 401');
  it.todo('approving a withdrawal of a locked player is refused until the lock is released');
});

describe('withdrawal lock and release', () => {
  it.todo(
    "an admin locking a player's withdrawals with a reason makes new withdrawals of that player wait for release and writes an audit row",
  );
  it.todo(
    'an admin releasing the lock with a reason lets the held withdrawals be approved and writes an audit row',
  );
  it.todo('locking or releasing without a reason is refused');
});

describe('auto-withdrawal rules and config', () => {
  it.todo(
    'an admin setting the global auto-withdrawal threshold sees it applied to the next withdrawal and an audit row written',
  );
  it.todo('an admin setting a per-player rule overrides the global threshold for that player only');
  it.todo(
    'an admin deleting a per-player rule returns that player to the global threshold and writes an audit row',
  );
  it.todo('with no global threshold or a zero threshold every withdrawal waits in the admin queue');
  it.todo('a threshold value that is not a valid decimal amount is refused');
  it.todo('a non-admin changing auto-withdrawal config or rules is refused with 403');
});

describe('manual balance adjustment', () => {
  it.todo(
    'an admin crediting a player manually raises the balance and writes one ledger row and one audit row with the reason',
  );
  it.todo(
    'an admin debiting a player manually lowers the balance and writes one ledger row and one audit row with the reason',
  );
  it.todo('a manual debit larger than the balance is refused and the balance never goes negative');
  it.todo('a manual adjustment replayed with the same idempotency key applies once');
  it.todo('a manual adjustment with the same key and a different amount is refused');
  it.todo('a manual adjustment without a reason is refused');
  it.todo('a non-admin requesting a manual adjustment is refused with 403');
});
