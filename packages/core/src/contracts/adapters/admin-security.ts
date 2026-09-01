/**
 * Admin session-security seam. `AdminGuard` lives in the engine zone and may not
 * import PAM tables (ADR-0019/0025), so the enrolment + fingerprint checks it runs
 * on every admin request are resolved through this port. The identity module binds
 * the implementation; when the module is absent the guard skips the checks.
 */
import { createToken, type Token } from './token.js';

export type AdminSessionContext = {
  userId: string;
  // Null when the session lookup returned no row id (stubbed/partial getSession);
  // the fingerprint check is skipped in that case, the enrolment check is not.
  sessionId: string | null;
  ip: string | null;
  userAgent: string | null;
};

export type AdminSecurityPolicy = {
  /**
   * Throws when the caller has no second factor configured, so a Backoffice
   * account cannot reach any admin route before completing enrolment.
   */
  assertEnrolled(context: AdminSessionContext): Promise<void>;
  /**
   * Throws when the caller's session no longer matches the device it was issued
   * to. Revokes the session before throwing, so the next request re-authenticates.
   */
  assertSessionIntact(context: AdminSessionContext): Promise<void>;
};

export const ADMIN_SECURITY_POLICY: Token<AdminSecurityPolicy> =
  createToken<AdminSecurityPolicy>('ADMIN_SECURITY_POLICY');
