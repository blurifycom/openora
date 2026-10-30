import type { RegistrationAcquisition } from '../schemas/identity.js';
import { createToken, type Token } from './token.js';

export type PlayerProvisioning = {
  /**
   * `created: false` means a player row already existed, so this consent record - and
   * the acquisition, when one was passed - was NOT stored. Callers must surface that - it
   * is a compliance record, not a no-op.
   *
   * `onCreated` runs inside the transaction that creates the player row, so whatever it
   * writes (an outbox event) commits with that row or not at all. It is not called when
   * the row already existed. Optional for an adapter predating it: the caller must then
   * fall back on its own.
   */
  createForRegistration(
    record: PlayerRegistrationRecord,
    onCreated?: (tx: unknown, playerId: string) => Promise<void>,
  ): Promise<{ created: boolean; playerId?: string }>;

  /**
   * Stores the IANA zone a browser reported. Display metadata - it never gates anything and
   * never reaches an RG window or an audit record. Best-effort by contract: an unrecognised
   * zone, or a player with no row yet, is a silent no-op. Call only after authentication.
   * Optional: an operator's own provisioning adapter predating this method still satisfies
   * the port, and a caller that skips the write costs the player nothing.
   */
  recordTimezone?(userId: string, timezone: string): Promise<void>;
};

export type PlayerRegistrationRecord = {
  userId: string;
  termsVersion: string;
  termsAcceptedAt: Date;
  ageAcceptedAt: Date;
  registrationIp: string | null;
  registrationUserAgent: string | null;
  acquisition?: RegistrationAcquisition;
};

export const PLAYER_PROVISIONING: Token<PlayerProvisioning> = createToken('PLAYER_PROVISIONING');
