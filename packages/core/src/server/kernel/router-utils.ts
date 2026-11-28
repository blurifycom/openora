import { ORPCError, os } from '@orpc/server';
import * as z from 'zod';
import type { ClientMeta } from '@openora/core/contracts';
import { AuthGuardReasonSchema } from '@openora/core/contracts';

export type NodeHeaders = Record<string, string | string[] | undefined>;

type RequestLike = { headers: NodeHeaders };

export const AuthContextSchema = z.object({
  userId: z.string(),
  sessionId: z.string().optional(),
  twoFactorSetupRequired: z.boolean().optional(),
});
export type AuthContext = z.infer<typeof AuthContextSchema>;

export const SessionEndedReasonSchema = z.literal('idle_timeout');
export type SessionEndedReason = z.infer<typeof SessionEndedReasonSchema>;

export type OssContext = {
  request: RequestLike;
  clientMeta: ClientMeta;
  auth?: AuthContext;
  sessionEndedReason?: SessionEndedReason;
  sessionUnavailable?: true;
  resHeaders?: Headers;
  rawBody?: string;
};

export type InternalContext = Omit<
  OssContext,
  'auth' | 'sessionEndedReason' | 'sessionUnavailable'
> & {
  auth?: never;
  internalCaller: string;
};

export const internalProcedure = os.$context<InternalContext>().use(({ context, next }) => {
  if (typeof context.internalCaller !== 'string' || context.internalCaller === '') {
    throw new ORPCError('NOT_FOUND');
  }
  return next();
});

export function parseInternalCallers(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

export function internalProcedureFor(callers: ReadonlySet<string>, refusal: string) {
  return internalProcedure.use(({ context, next }) => {
    if (!callers.has(context.internalCaller)) {
      throw new ORPCError('FORBIDDEN', { message: refusal });
    }
    return next();
  });
}

export type ResolveAuthOptions = {
  allowPendingTwoFactorSetup?: boolean;
};

export function throwIfSessionUnavailable(context: unknown): void {
  if ((context as { sessionUnavailable?: true }).sessionUnavailable) {
    throw new ORPCError('SERVICE_UNAVAILABLE', {
      message: 'The session service is unavailable',
    });
  }
}

function resolveAuth(context: unknown, opts?: ResolveAuthOptions): AuthContext {
  if (
    typeof context !== 'object' ||
    context === null ||
    !('request' in context) ||
    typeof (context as Record<string, unknown>).request !== 'object'
  ) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'Missing request context',
      data: { reason: AuthGuardReasonSchema.enum.missing_request_context },
    });
  }

  const auth = (context as { auth?: AuthContext }).auth;
  if (!auth?.userId) {
    throwIfSessionUnavailable(context);
    throw new ORPCError('UNAUTHORIZED', {
      message: 'Authentication required',
      data: { reason: AuthGuardReasonSchema.enum.authentication_required },
    });
  }

  if (auth.twoFactorSetupRequired && !opts?.allowPendingTwoFactorSetup) {
    throw new ORPCError('FORBIDDEN', {
      message: 'Set up two-factor authentication to continue',
      data: { reason: AuthGuardReasonSchema.enum.two_factor_setup_required },
    });
  }

  return auth;
}

export function getUserId(context: unknown, opts?: ResolveAuthOptions): string {
  return resolveAuth(context, opts).userId;
}

export function getSessionId(context: unknown, opts?: ResolveAuthOptions): string | undefined {
  return resolveAuth(context, opts).sessionId;
}

export function extractClientMeta(headers: NodeHeaders): ClientMeta {
  const real = headers['x-real-ip'];
  const ip = (Array.isArray(real) ? real[0] : real) || null;
  const ua = headers['user-agent'];
  return { ip, userAgent: (Array.isArray(ua) ? ua[0] : ua) ?? null };
}
