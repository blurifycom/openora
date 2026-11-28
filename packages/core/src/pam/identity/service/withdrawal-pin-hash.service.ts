import { createHmac } from 'node:crypto';

export const MIN_WITHDRAWAL_PIN_SECRET_LENGTH = 32;

export function hashWithdrawalPin(pin: string, secret: string): string {
  return createHmac('sha256', secret).update(pin).digest('hex');
}
