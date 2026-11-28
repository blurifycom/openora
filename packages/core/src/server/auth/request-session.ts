import * as z from 'zod';
import {
  createToken,
  type PlayerActivityTracker,
  type SessionIdlePolicy,
  type Token,
  type TwoFactorSetupPolicy,
} from '@openora/core/contracts';
import { createLogger } from '../kernel/logger.js';
import {
  AuthContextSchema,
  SessionEndedReasonSchema,
  type AuthContext,
  type SessionEndedReason,
} from '../kernel/router-utils.js';
import type { SessionResolver } from './session-resolver.js';

export type SessionOutcome = {
  auth?: AuthContext;
  sessionEndedReason?: SessionEndedReason;
  unavailable?: true;
};

export type RequestSessionResolver = {
  resolve(headers: Headers): Promise<SessionOutcome>;
};

export const LOCAL_SESSION_RESOLVER: Token<RequestSessionResolver> =
  createToken('LOCAL_SESSION_RESOLVER');

export const REMOTE_SESSION_RESOLVER: Token<RequestSessionResolver> =
  createToken('REMOTE_SESSION_RESOLVER');

export type SessionChainPorts = {
  sessions: Pick<SessionResolver, 'resolveSession'>;
  idlePolicy: SessionIdlePolicy | undefined;
  twoFactorPolicy: TwoFactorSetupPolicy | undefined;
  activity: PlayerActivityTracker | undefined;
};

export async function resolveSessionChain(
  ports: () => SessionChainPorts,
  headers: Headers,
): Promise<SessionOutcome> {
  const { sessions, idlePolicy, twoFactorPolicy, activity } = ports();
  const resolved = await sessions.resolveSession(headers);
  if (!resolved) {
    return {};
  }
  const { userId, sessionId } = resolved;

  if (sessionId && idlePolicy) {
    let state: 'active' | 'expired' | 'idle';
    try {
      state = await idlePolicy.touch(userId, sessionId);
    } catch (err) {
      createLogger('session-idle').error({ err }, 'touch failed');
      state = 'expired';
    }
    if (state !== 'active') {
      return state === 'idle' ? { sessionEndedReason: 'idle_timeout' } : {};
    }
  }

  let twoFactorSetupRequired = false;
  if (twoFactorPolicy) {
    try {
      twoFactorSetupRequired = await twoFactorPolicy.isSetupRequired(userId);
    } catch (err) {
      createLogger('two-factor-setup').error({ err }, 'setup check failed');
      return {};
    }
  }

  if (activity) {
    await activity
      .touchLastSeen(userId)
      .catch((err: unknown) =>
        createLogger('player-activity').error({ err }, 'touchLastSeen failed'),
      );
  }

  return { auth: twoFactorSetupRequired ? { ...resolved, twoFactorSetupRequired } : resolved };
}

export const SESSION_RESOLVER_ROUTE = '/identity/session';

const CREDENTIAL_MAX_LENGTH = 16_384;

export const SessionResolverWire = {
  input: z.object({
    cookie: z.string().max(CREDENTIAL_MAX_LENGTH).optional(),
    authorization: z.string().max(CREDENTIAL_MAX_LENGTH).optional(),
  }),
  output: z.object({
    auth: AuthContextSchema.nullable(),
    sessionEndedReason: SessionEndedReasonSchema.optional(),
  }),
} as const;
