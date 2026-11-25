import { describe, it } from 'vitest';

describe('wallet reader parity', () => {
  it.todo(
    'every WALLET_READER method returns what its original table query returns for the same seeded player, on the pool',
  );
  it.todo(
    'every WALLET_READER method sees uncommitted rows when it is given the caller transaction',
  );
  it.todo(
    'getBalance and getBalances return zero balances, never null, for a player with no wallet rows',
  );
  it.todo(
    'getMoneyByWindow and getTurnoverSince count only rows inside the window, with the window start included and the end excluded',
  );
  it.todo(
    'getWithdrawalCountInWindow and getWithdrawalCountsInWindow agree for the same players and window',
  );
  it.todo(
    'findOwnProviderTransaction returns nothing for a provider reference that belongs to another player',
  );
  it.todo(
    'sumProviderTransactions under the debt row lock matches the sum of the provider transactions already taken',
  );
  it.todo('hasWallet is false before the first wallet row and true after it');
});
