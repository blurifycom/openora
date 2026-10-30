import { createHash, randomUUID } from 'node:crypto';

/**
 * A fresh invitation token. It stays a UUID so the links already in circulation and every
 * consumer that recognises one in a mail keep working; the 122 random bits are not the
 * guessing defence on their own - `acceptInvitation` is also throttled per client address.
 */
export function generateInvitationToken() {
  return randomUUID();
}

/** The digest stored in `admin_invitation.token_hash`; matches migration 0004's backfill. */
export function hashInvitationToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
