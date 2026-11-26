import { describe, expect, it } from 'vitest';
import type { MailSendJob } from '../contract/index.js';
import {
  createMailPayloadCipher,
  MIN_MAIL_ENCRYPTION_SECRET_LENGTH,
} from '../service/mail-payload.service.js';

const secret = 's'.repeat(MIN_MAIL_ENCRYPTION_SECRET_LENGTH);

const job: MailSendJob = {
  recipient: { kind: 'address', email: 'player@example.com', locale: 'en' },
  template: { key: 'withdrawalsLocked', data: { occurredAt: '2026-11-26T10:00:00.000Z' } },
};

describe('mail payload cipher', () => {
  it('a payload round trips through encrypt and decrypt', () => {
    const cipher = createMailPayloadCipher(secret);
    expect(cipher.decrypt(cipher.encrypt(job))).toEqual(job);
    expect(JSON.stringify(cipher.encrypt(job))).not.toContain('player@example.com');
  });

  it('a secret shorter than the minimum length is rejected', () => {
    expect(() =>
      createMailPayloadCipher('s'.repeat(MIN_MAIL_ENCRYPTION_SECRET_LENGTH - 1)),
    ).toThrow(/at least 32 characters/);
    expect(() => createMailPayloadCipher(secret)).not.toThrow();
  });

  it('a tampered payload fails to decrypt', () => {
    const cipher = createMailPayloadCipher(secret);
    const sealed = cipher.encrypt(job);
    const flipped = (value: string) => `${value.startsWith('A') ? 'B' : 'A'}${value.slice(1)}`;
    const message = 'mail job payload could not be decrypted';
    expect(() => cipher.decrypt({ ...sealed, ciphertext: flipped(sealed.ciphertext) })).toThrow(
      message,
    );
    expect(() => cipher.decrypt({ ...sealed, tag: flipped(sealed.tag) })).toThrow(message);
    expect(() => cipher.decrypt({ ...sealed, iv: flipped(sealed.iv) })).toThrow(message);
    expect(() => createMailPayloadCipher('t'.repeat(32)).decrypt(sealed)).toThrow(message);
  });

  it('the same payload encrypts to different ciphertexts', () => {
    const cipher = createMailPayloadCipher(secret);
    const first = cipher.encrypt(job);
    const second = cipher.encrypt(job);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.iv).not.toBe(second.iv);
  });
});
