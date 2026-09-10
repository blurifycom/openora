/**
 * Push port for the per-player "auto-logout when inactive" setting. Bound by the identity
 * module (it owns the `user` and `session` tables); the request middleware depends only on
 * this port and never on the identity schema (ADR-0019/0025).
 *
 * `touch` runs once per authenticated request. It records activity on the session and
 * answers `expired` when the session has already sat idle past the player's chosen window
 * - by then it has been revoked, so the caller must treat the request as unauthenticated
 * rather than trusting the resolved session.
 */
import { createToken, type Token } from './token.js';

export type SessionIdlePolicy = {
  touch(userId: string, sessionId: string): Promise<'active' | 'expired'>;
};

export const SESSION_IDLE_POLICY: Token<SessionIdlePolicy> = createToken('SESSION_IDLE_POLICY');
