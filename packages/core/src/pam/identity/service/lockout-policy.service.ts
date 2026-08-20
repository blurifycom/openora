import { ORPCError } from '@orpc/server';
import type { LoginSecurityState } from '@openora/core/contracts';

export const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;
export const DEFAULT_LOCKOUT_DURATION_MS = 15 * 60 * 1000;
export const LOCKOUT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const LOCKOUT_TIER_DURATIONS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

export function isActiveLockout(lockoutUntil: Date | null | undefined, nowMs = Date.now()) {
  return lockoutUntil !== null && lockoutUntil !== undefined && lockoutUntil.getTime() > nowMs;
}

export function hasFailedLoginWindowExpired(
  lastFailedLoginAt: Date | null | undefined,
  fallbackLastLockoutAt?: Date | null,
  nowMs = Date.now(),
) {
  const effectiveLastFailedLoginAt = lastFailedLoginAt ?? fallbackLastLockoutAt;
  return (
    effectiveLastFailedLoginAt !== null &&
    effectiveLastFailedLoginAt !== undefined &&
    nowMs - effectiveLastFailedLoginAt.getTime() >= LOCKOUT_WINDOW_MS
  );
}

export function computeLockoutTier({
  lockoutCount,
  lastFailedLoginAt,
  fallbackLastLockoutAt,
  nowMs,
  fallbackDurationMs = DEFAULT_LOCKOUT_DURATION_MS,
}: {
  lockoutCount: number;
  lastFailedLoginAt: Date | null;
  fallbackLastLockoutAt?: Date | null;
  nowMs: number;
  fallbackDurationMs?: number;
}) {
  const effectiveLastFailedLoginAt = lastFailedLoginAt ?? fallbackLastLockoutAt ?? null;
  const withinWindow =
    effectiveLastFailedLoginAt !== null &&
    nowMs - effectiveLastFailedLoginAt.getTime() < LOCKOUT_WINDOW_MS;
  const tier = withinWindow ? lockoutCount + 1 : 1;
  const durationMs = LOCKOUT_TIER_DURATIONS_MS[Math.min(tier - 1, 2)] ?? fallbackDurationMs;
  return { tier, durationMs };
}

export function makeLoginSecurityState({
  failedLoginAttempts,
  maxAttempts = DEFAULT_MAX_LOGIN_ATTEMPTS,
  lockoutUntil,
  nowMs = Date.now(),
}: {
  failedLoginAttempts: number;
  maxAttempts?: number;
  lockoutUntil: Date | null;
  nowMs?: number;
}): LoginSecurityState {
  const active = isActiveLockout(lockoutUntil, nowMs);
  return {
    attemptsRemaining: active ? 0 : Math.max(maxAttempts - failedLoginAttempts, 0),
    lockoutUntil: active ? (lockoutUntil?.toISOString() ?? null) : null,
  };
}

export function createAccountLockedError(lockoutUntil: Date) {
  return new ORPCError('UNAUTHORIZED', {
    message: 'Account is temporarily locked. Please try again later.',
    data: {
      code: 'ACCOUNT_LOCKED',
      attemptsRemaining: 0,
      lockoutUntil: lockoutUntil.toISOString(),
    },
  });
}
