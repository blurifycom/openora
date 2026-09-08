import { createHmac } from 'node:crypto';

// A 4-digit PIN is long-lived and low-entropy (10,000 possibilities); the plain-sha256
// pattern in pam/shared/otp.ts is only safe there because those OTPs expire in minutes.
// HMAC-SHA256 with a dedicated, never-reused secret closes that gap without inventing a
// new primitive family (same shape as server/auth/sign-session-cookie.ts).
export const MIN_WITHDRAWAL_PIN_SECRET_LENGTH = 32;

export function hashWithdrawalPin(pin: string, secret: string): string {
  return createHmac('sha256', secret).update(pin).digest('hex');
}
