import { describe, it } from 'vitest';

describe('player balances and transaction history', () => {
  it.todo('a player reads only their own balances and active currency');
  it.todo('a player setting an active currency the operator does not offer is refused');
  it.todo(
    'a player listing transactions sees their own rows with the status and reference conversion and none of another player',
  );
  it.todo(
    "an admin listing a player's transactions sees rows filtered by type, status and currency and paged with a matching total",
  );
  it.todo('an unauthenticated caller reading balances or transactions is refused with 401');
  it.todo('a player calling an admin transaction list is refused with 403');
});

describe('ledger atomicity', () => {
  it.todo(
    'every balance change writes a ledger row in the same transaction and a failed change leaves neither',
  );
  it.todo('a ledger row records its direction and balance after the move');
  it.todo('concurrent debits of one wallet never overspend and the balance never goes negative');
  it.todo('a completed ledger row cannot be reopened or deleted');
});
