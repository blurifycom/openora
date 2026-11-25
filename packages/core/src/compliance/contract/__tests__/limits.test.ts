import { describe, it } from 'vitest';

describe('limit consistency', () => {
  it.todo('a session limit with the session period is consistent');
  it.todo('a session limit with a non-session period is inconsistent');
  it.todo('a non-session limit with the session period is inconsistent');
  it.todo('a session limit with minutes and no amount is consistent');
  it.todo('a session limit with an amount or without minutes is inconsistent');
  it.todo('a money limit with an amount and no minutes is consistent');
  it.todo('a money limit with minutes or without an amount is inconsistent');
  it.todo('a session limit with a currency is inconsistent');
  it.todo('a money limit without a currency is inconsistent');
});
