import { createHash, randomUUID } from 'node:crypto';

export function generateInvitationToken() {
  return randomUUID();
}

export function hashInvitationToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
