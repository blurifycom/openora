import { describe, it } from 'vitest';

describe('withdrawal policy evaluation', () => {
  it.todo('does not require KYC when the global switch is off');
  it.todo('requires KYC when the pivot amount is unknown');
  it.todo('requires KYC when the amount exceeds the withdrawal threshold');
  it.todo('does not require KYC at exactly the cumulative threshold');
  it.todo('requires KYC just above the cumulative threshold');
  it.todo('requires KYC when a deposit currency cannot be priced');
  it.todo('uses the default threshold when no configuration row exists');
  it.todo('rejects when the deposits read fails so the request is refused');
});
