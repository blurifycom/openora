import { describe, it, expect } from 'vitest';
import { perRecipientAmount } from '../service/notifications.service.js';

describe('perRecipientAmount', () => {
  it('recovers the exact per-recipient share from an even split', () => {
    expect(perRecipientAmount('100.00', 5)).toBe('20.00');
  });

  it('recovers the exact per-recipient share when fewer recipients received the rain', () => {
    // 100 requested for 5, only 4 available: perRecipient=20, totalDistributed=80.
    expect(perRecipientAmount('80.00', 4)).toBe('20.00');
  });

  it('handles a single recipient', () => {
    expect(perRecipientAmount('12.50', 1)).toBe('12.50');
  });

  it('preserves the decimal scale of the input', () => {
    expect(perRecipientAmount('30', 3)).toBe('10');
  });
});
