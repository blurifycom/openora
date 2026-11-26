import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { EncryptedMailSendJob, MailSendJob } from '../../contract/index.js';
import { createMailPayloadCipher, toKey } from '../mail-payload.service.js';

const SECRET = 'a-test-secret-that-is-at-least-32-chars';
const OTHER_SECRET = 'another-test-secret-at-least-32-chars!';

const JOB: MailSendJob = {
  recipient: { kind: 'address', email: 'player@example.test', locale: 'en' },
  template: { key: 'twoFactorOtp', data: { otp: '123456' } },
};

const flipFirstByte = (base64url: string) => {
  const bytes = Buffer.from(base64url, 'base64url');
  bytes.writeUInt8((bytes.readUInt8(0) + 1) % 256, 0);
  return bytes.toString('base64url');
};

describe('toKey', () => {
  it('derives a 32 byte key', () => {
    expect(toKey(SECRET)).toHaveLength(32);
  });

  it('is stable for one secret and differs between secrets', () => {
    expect(toKey(SECRET).equals(toKey(SECRET))).toBe(true);
    expect(toKey(SECRET).equals(toKey(OTHER_SECRET))).toBe(false);
  });

  it('does not use the secret bytes as the key', () => {
    const secret = 'k'.repeat(32);
    expect(toKey(secret).equals(Buffer.from(secret))).toBe(false);
  });
});

describe('createMailPayloadCipher', () => {
  it.each([[''], ['x'.repeat(31)]])(
    'refuses a secret of %j shorter than 32 characters',
    (secret) => {
      expect(() => createMailPayloadCipher(secret)).toThrow(/at least 32 characters/);
    },
  );

  it('accepts a secret of exactly 32 characters', () => {
    expect(() => createMailPayloadCipher('x'.repeat(32))).not.toThrow();
  });

  it('round trips a job', () => {
    const cipher = createMailPayloadCipher(SECRET);
    expect(cipher.decrypt(cipher.encrypt(JOB))).toEqual(JOB);
  });

  it('round trips any otp and recipient name', () => {
    const cipher = createMailPayloadCipher(SECRET);
    fc.assert(
      fc.property(fc.string(), fc.option(fc.string()), (otp, recipientName) => {
        const job: MailSendJob = {
          recipient: { kind: 'address', email: 'player@example.test', recipientName },
          template: { key: 'twoFactorOtp', data: { otp } },
        };
        expect(cipher.decrypt(cipher.encrypt(job))).toEqual(job);
      }),
      { numRuns: 50 },
    );
  });

  it('keeps the plaintext out of the encrypted job', () => {
    const encrypted = createMailPayloadCipher(SECRET).encrypt(JOB);
    const stored = JSON.stringify(encrypted);
    expect(stored).not.toContain('player@example.test');
    expect(stored).not.toContain('123456');
    expect(Buffer.from(encrypted.iv, 'base64url')).toHaveLength(12);
    expect(Buffer.from(encrypted.tag, 'base64url')).toHaveLength(16);
  });

  it('uses a fresh iv for every encryption', () => {
    const cipher = createMailPayloadCipher(SECRET);
    const first = cipher.encrypt(JOB);
    const second = cipher.encrypt(JOB);
    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  it.each([
    [
      'ciphertext',
      (job: EncryptedMailSendJob) => ({ ...job, ciphertext: flipFirstByte(job.ciphertext) }),
    ],
    ['iv', (job: EncryptedMailSendJob) => ({ ...job, iv: flipFirstByte(job.iv) })],
    ['tag', (job: EncryptedMailSendJob) => ({ ...job, tag: flipFirstByte(job.tag) })],
    [
      'tag truncated to 4 bytes',
      (job: EncryptedMailSendJob) => ({
        ...job,
        tag: Buffer.from(job.tag, 'base64url').subarray(0, 4).toString('base64url'),
      }),
    ],
    [
      'ciphertext truncated',
      (job: EncryptedMailSendJob) => ({
        ...job,
        ciphertext: Buffer.from(job.ciphertext, 'base64url').subarray(1).toString('base64url'),
      }),
    ],
  ])('refuses a job whose %s was tampered with', (_name, tamper) => {
    const cipher = createMailPayloadCipher(SECRET);
    expect(() => cipher.decrypt(tamper(cipher.encrypt(JOB)))).toThrow(
      'mail job payload could not be decrypted',
    );
  });

  it('refuses a job sealed with another secret', () => {
    const sealed = createMailPayloadCipher(OTHER_SECRET).encrypt(JOB);
    expect(() => createMailPayloadCipher(SECRET).decrypt(sealed)).toThrow(
      'mail job payload could not be decrypted',
    );
  });

  it('refuses an authentic payload that is not a mail job', () => {
    const cipher = createMailPayloadCipher(SECRET);
    const sealed = cipher.encrypt({
      recipient: { kind: 'address', email: 'not-an-email' },
      template: JOB.template,
    });
    expect(() => cipher.decrypt(sealed)).toThrow('mail job payload could not be decrypted');
  });
});
