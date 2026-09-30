import { ORPCError } from '@orpc/server';
import { eq } from 'drizzle-orm';
import type { DrizzleService, EventBus } from '@openora/core/server';
import type { ClientMeta, GeoCheckCommands, User } from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import { session } from '../schema/index.js';

export function isRgBlocked(u: { rgBlocked: boolean; rgBlockedUntil: Date | null }): boolean {
  return u.rgBlocked && (u.rgBlockedUntil === null || u.rgBlockedUntil > new Date());
}

type BlockedAccount = { id: User['id']; rgBlocked: boolean; rgBlockedUntil: Date | null };

type AccountBlockGateOptions = {
  /**
   * Expire every session on the account before throwing. Needed wherever the caller has
   * already let better-auth mint one (password login, email-code verification); the phone
   * path checks the gate before minting, so it has nothing to revoke and passes false.
   */
  revokeSessions: boolean;
  /** `ORPCError.data` for each block, so each surface keeps its own error vocabulary. */
  errorData: { rgBlocked: Record<string, string>; suspended: Record<string, string> };
};

/**
 * The RG and backoffice (suspended/closed) gates for an account that has just proven a
 * credential - never before, so a probe can't tell a restricted account apart from a
 * wrong secret. Shared by every surface that hands out a session, so the three of them
 * cannot drift: a gate that only some login paths enforce is not a gate.
 * Returns the resolved playerId so callers can attach it to their own success event.
 */
export async function assertAccountNotBlocked(
  { drizzle, events }: { drizzle: DrizzleService; events: EventBus },
  account: BlockedAccount,
  { ip, userAgent }: ClientMeta,
  { revokeSessions, errorData }: AccountBlockGateOptions,
): Promise<string | null> {
  const [playerRow] = await drizzle.db
    .select({ id: player.id, status: player.status })
    .from(player)
    .where(eq(player.userId, account.id))
    .limit(1);

  const revoke = async () => {
    if (revokeSessions) {
      await drizzle.db
        .update(session)
        .set({ expiresAt: new Date() })
        .where(eq(session.userId, account.id));
    }
  };

  if (isRgBlocked(account)) {
    await revoke();
    events.emit('rg.exclusion.login_blocked', {
      userId: account.id,
      playerId: playerRow?.id ?? null,
      ip,
      userAgent,
    });
    throw new ORPCError('FORBIDDEN', {
      message: 'Account access is currently restricted (responsible gambling).',
      data: errorData.rgBlocked,
    });
  }

  // Distinct mechanism from RG (self_excluded is out of scope here) - a suspended or
  // closed player can never log back in.
  if (playerRow && (playerRow.status === 'suspended' || playerRow.status === 'closed')) {
    await revoke();
    events.emit('player.login_blocked', {
      userId: account.id,
      playerId: playerRow.id,
      status: playerRow.status,
      ip,
      userAgent,
    });
    throw new ORPCError('FORBIDDEN', {
      message: 'This account has been suspended and can no longer be used.',
      data: errorData.suspended,
    });
  }

  return playerRow?.id ?? null;
}

/**
 * The country rule for an account that has just proven a credential, on every surface that
 * hands out a session - a rule only some sign-in paths enforce is bypassed by switching
 * flows. After the credential, not before, so staff keep backoffice access from a blocked
 * country without the exemption turning into a pre-auth probe for which addresses are
 * staff. The denial is audited by the compliance decision itself
 * (`compliance.geo.access_blocked`); `onDenied` is only the caller's own cleanup.
 */
export async function assertCountryAllowed(
  geoCheck: GeoCheckCommands | undefined,
  account: { role: string },
  ip: string | null,
  onDenied?: (countryCode: string | null) => Promise<void> | void,
): Promise<void> {
  if (!geoCheck || account.role === 'admin') {
    return;
  }
  const decision = await geoCheck.checkAccess(ip);
  if (decision.allowed) {
    return;
  }
  await onDenied?.(decision.countryCode);
  throw new ORPCError('FORBIDDEN', {
    message: 'Login is unavailable',
    data: { code: 'GEO_BLOCKED' },
  });
}
