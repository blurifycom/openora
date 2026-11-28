import * as z from 'zod';
import { createToken, type Token } from './token.js';

export type AdminSessionContext = {
  userId: string;
  sessionId: string | null;
  ip: string | null;
  userAgent: string | null;
};

export type AdminSecurityPolicy = {
  assertEnrolled(context: AdminSessionContext): Promise<void>;
  assertSessionIntact(context: AdminSessionContext): Promise<void>;
};

export const ADMIN_SECURITY_POLICY: Token<AdminSecurityPolicy> =
  createToken<AdminSecurityPolicy>('ADMIN_SECURITY_POLICY');

export const ADMIN_SECURITY_ROUTE = '/identity/admin-security';

export const AdminSecurityWire = {
  input: z.object({
    check: z.enum(['enrolled', 'session_intact']),
    userId: z.string().max(64),
    sessionId: z.string().max(64).nullable(),
    ip: z.string().max(128).nullable(),
    userAgent: z.string().max(16_384).nullable(),
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
