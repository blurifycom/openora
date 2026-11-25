import { describe, it } from 'vitest';

describe('computeLockoutTier', () => {
  it.todo('the first lockout is tier 1 and lasts one minute');
  it.todo('the second lockout within 24 hours is tier 2 and lasts five minutes');
  it.todo('the third lockout within 24 hours is tier 3 and lasts fifteen minutes');
  it.todo('a fourth and later lockout stays at fifteen minutes');
  it.todo('a last failure older than 24 hours resets the tier to 1');
  it.todo('a last failure exactly 24 hours ago resets the tier to 1');
  it.todo('a missing last failure falls back to the last lockout time');
  it.todo('with no failure and no lockout time the tier is 1');
});

describe('isActiveLockout', () => {
  it.todo('a null or undefined lockout is not active');
  it.todo('a lockout in the future is active');
  it.todo('a lockout equal to now is not active');
});

describe('hasFailedLoginWindowExpired', () => {
  it.todo('no failure time and no fallback is not expired');
  it.todo('a failure under 24 hours ago is not expired');
  it.todo('a failure 24 hours ago or older is expired');
  it.todo('the fallback lockout time is used when there is no failure time');
});

describe('makeLoginSecurityState', () => {
  it.todo('reports the attempts remaining below the maximum');
  it.todo('never reports negative attempts remaining');
  it.todo('an active lockout reports zero attempts and the expiry');
  it.todo('an expired lockout reports no expiry and the remaining attempts');
});
