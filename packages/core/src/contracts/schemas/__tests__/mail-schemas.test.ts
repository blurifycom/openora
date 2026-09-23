import { describe, it, expect } from 'vitest';
import { MailTemplateSchema } from '../mail.js';

const depositIn = (currency: string) =>
  MailTemplateSchema.safeParse({
    key: 'depositCompleted',
    data: {
      amount: '25.00',
      currency,
      transactionId: '3f1a6d2e-27cc-4a4b-9f0a-1d4a5b6c7d8e',
      occurredAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    },
  });

describe('MailTemplateSchema currency', () => {
  it('accepts a four-letter crypto ticker', () => {
    expect(depositIn('USDT').success).toBe(true);
  });

  it('still accepts a three-letter fiat code', () => {
    expect(depositIn('USD').success).toBe(true);
  });
});
