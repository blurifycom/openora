import { describe, it, expect } from 'vitest';
import { createToken, createSealedToken, createClientPageToken } from '../token.js';

describe('token descriptions', () => {
  it('leaves a plain token description as given - it is what an unbound-port error prints', () => {
    expect(createToken('PAYMENT_ADAPTER').description).toBe('PAYMENT_ADAPTER');
  });

  it('prefixes a sealed token so a regulator-mandated binding is obvious in a trace', () => {
    expect(createSealedToken('ledger-writer').description).toBe('sealed:ledger-writer');
  });

  it('prefixes a client page token to mark it as a Tier 3 page override', () => {
    expect(createClientPageToken('admin-users').description).toBe('page:admin-users');
  });
});
