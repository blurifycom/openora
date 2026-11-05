/**
 * Push port for the per-player "auto-logout when inactive" setting. Bound by the identity
 * module (it owns the `user` and `session` tables); the request middleware depends only on
 * this port and never on the identity schema (ADR-0019/0025).
 *
 * `touch` runs once per authenticated request. It records activity on the session and
 * answers `expired` when the session can no longer be used - the account was deactivated,
 * or the session is gone. It answers `idle` when the session sat idle past its window; the
 * caller uses that to tell the user why they were signed out. In both cases the session has
 * been revoked, so the caller must treat the request as unauthenticated rather than trusting
 * the resolved session.
 */
import { createToken, type Token } from './token.js';

export type SessionIdlePolicy = {
  touch(userId: string, sessionId: string): Promise<'active' | 'expired' | 'idle'>;
};

export const SESSION_IDLE_POLICY: Token<SessionIdlePolicy> = createToken('SESSION_IDLE_POLICY');
