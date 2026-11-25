import { describe, it } from 'vitest';

describe('offerIneligibility', () => {
  it.todo('returns offer_inactive when the offer status is not active');
  it.todo('returns outside_validity_window before the start');
  it.todo('returns outside_validity_window after the end');
  it.todo('accepts the instant at the start and at the end of the window');
  it.todo(
    'returns not_first_deposit for a first-deposit-only offer when the fact is false or absent',
  );
  it.todo('returns null when no deposit is supplied and the offer is open');
  it.todo('returns currency_mismatch when the deposit currency differs');
  it.todo('returns below_minimum_deposit under the minimum');
  it.todo('returns null for a deposit exactly at the minimum');
});
