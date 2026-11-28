import { createHmac } from 'node:crypto';

function decodeBase32(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of input.toUpperCase().replace(/=+$/, '')) {
    const value = alphabet.indexOf(char);
    if (value === -1) {
      throw new Error(`invalid base32 character: ${char}`);
    }
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function totpCode(base32Secret: string, atMs = Date.now()): string {
  const key = decodeBase32(base32Secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / 30)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = (hmac.at(-1) ?? 0) & 0x0f;
  const truncated = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(truncated % 1_000_000).padStart(6, '0');
}

export function secretFromTotpUri(totpUri: string): string {
  const secret = new URL(totpUri.replace('otpauth://', 'http://')).searchParams.get('secret');
  if (!secret) {
    throw new Error(`no secret in totpUri: ${totpUri}`);
  }
  return secret;
}
