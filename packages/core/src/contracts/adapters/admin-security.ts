/**
 * Admin session-security seam. `AdminGuard` lives in the engine zone and may not
 * import PAM tables (ADR-0019/0025), so the enrolment + fingerprint checks it runs
 * on every admin request are resolved through this port. The identity module binds
 * the implementation; when the module is absent the guard skips the checks.
 */
import * as z from 'zod';
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

/** The identity service's internal route behind a remote {@link AdminSecurityPolicy}, under `/internal/v1`. */
export const ADMIN_SECURITY_ROUTE = '/identity/admin-security';

/**
 * Request and reply of {@link ADMIN_SECURITY_ROUTE}. A service with no identity tables of its
 * own cannot run either check against its database, so the identity service runs it and answers
 * with the refusal it would have thrown. The caller's address and user agent travel in the body
 * because the check compares them with the session's.
 */
export const AdminSecurityWire = {
  input: z.object({
    check: z.enum(['enrolled', 'session_intact']),
    userId: z.string().max(64),
    sessionId: z.string().max(64).nullable(),
    ip: z.string().max(128).nullable(),
    userAgent: z.string().max(2048).nullable(),
  }),
  output: z.object({
    refusal: z
      .object({
        code: z.enum(['FORBIDDEN', 'UNAUTHORIZED']),
        message: z.string(),
        reason: z.string().optional(),
      })
      .nullable(),
  }),
} as const;
