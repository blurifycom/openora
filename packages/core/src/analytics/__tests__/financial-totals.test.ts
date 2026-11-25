import { describe, it } from 'vitest';

describe('totals per currency', () => {
  it.todo('deposits across rails in one currency are summed into one total');
  it.todo('two currencies produce two separate totals and are never added together');
  it.todo('a currency present only in withdrawals appears with zero deposits');
  it.todo('net is deposits minus withdrawals per currency');
  it.todo('an empty summary produces no totals');
  it.todo('decimal amounts sum without floating point error');
  it.todo('a ggr bucket key is the same for a Date and its ISO string');
  it.todo('an omitted date range resolves to the default window');
});
