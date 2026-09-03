import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  MailSendJobSchema,
  type EncryptedMailSendJob,
  type MailSendJob,
} from '../contract/index.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
export const MIN_MAIL_ENCRYPTION_SECRET_LENGTH = 32;

export type MailPayloadCipher = {
  encrypt(job: MailSendJob): EncryptedMailSendJob;
  decrypt(job: EncryptedMailSendJob): MailSendJob;
};

const toKey = (secret: string): Buffer => createHash('sha256').update(secret).digest();

export function createMailPayloadCipher(secret: string): MailPayloadCipher {
  if (secret.length < MIN_MAIL_ENCRYPTION_SECRET_LENGTH) {
    throw new Error('AUTH_SECRET must have at least 32 characters to encrypt mail jobs');
  }
  const key = toKey(secret);
  return {
    encrypt(job) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(job), 'utf8'),
        cipher.final(),
      ]).toString('base64url');
      return {
        ciphertext,
        iv: iv.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
      };
    },
    decrypt(job) {
      try {
        const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(job.iv, 'base64url'));
        decipher.setAuthTag(Buffer.from(job.tag, 'base64url'));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(job.ciphertext, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
        return MailSendJobSchema.parse(JSON.parse(plaintext));
      } catch {
        throw new Error('mail job payload could not be decrypted');
      }
    },
  };
}
