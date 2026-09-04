import { createHash, randomInt } from 'node:crypto';

export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

// Never logged here: the code is a login credential, and NODE_ENV is not set by the
// consumer scaffold, so an env-guarded log leaks it on a stock deploy. MockSmsAdapter
// already prints it for dev, which is the one place it belongs.
export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}
