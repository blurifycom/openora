import { createHash, randomInt } from 'node:crypto';

export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}
