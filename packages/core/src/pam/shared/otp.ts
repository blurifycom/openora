import { createHash, randomInt } from 'node:crypto';

export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function generateCode(): string {
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  // Non-production only: lets a dev/test SMS adapter's console output double as the OTP
  // inbox without a real SMS gateway.
  if (process.env['NODE_ENV'] !== 'production') {
    console.log(`OTP code generated: ${code}`); // oxlint-disable-line no-console
  }
  return code;
}
