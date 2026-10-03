/**
 * Optional seam for "may a country rule redirect to this origin". Core accepts any https
 * origin as a mirror target; a consumer that keeps its own allowlist of mirror domains
 * binds this so `upsertCountryRule` refuses an unapproved origin inside its own
 * transaction. `tx` is the upsert's transaction, so the consumer can take a shared lock on
 * the approved row and a concurrent removal of that origin serialises against the upsert.
 */
import { createToken, type Token } from './token.js';

export type MirrorTargetPolicy = {
  isApprovedTarget(tx: unknown, origin: string): Promise<boolean>;
};

export const MIRROR_TARGET_POLICY: Token<MirrorTargetPolicy> = createToken('MIRROR_TARGET_POLICY');
