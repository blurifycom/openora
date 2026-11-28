import { ORPCError } from '@orpc/server';
import { eq } from 'drizzle-orm';
import type { DrizzleService, EventBus } from '@openora/core/server';
import type { ClientMeta, GeoCheckCommands, User } from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import { session } from '../schema/index.js';

export function isRgBlocked(u: { rgBlocked: boolean; rgBlockedUntil: Date | null }): boolean {
  return u.rgBlocked && (u.rgBlockedUntil === null || u.rgBlockedUntil > new Date());
}

type BlockedAccount = {
  id: User['id'];
  isActive: boolean;
  rgBlocked: boolean;
  rgBlockedUntil: Date | null;
};

type AccountBlockGateOptions = {
  revokeSessions: boolean;
  errorData: {
    rgBlocked: Record<string, string>;
    suspended: Record<string, string>;
    inactive: Record<string, string>;
  };
};

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

  const blockedPlayerStatus =
    playerRow && (playerRow.status === 'suspended' || playerRow.status === 'closed')
      ? playerRow.status
      : null;

  if (!account.isActive) {
    await revoke();
    events.emit('identity.user.login_blocked', {
      userId: account.id,
      playerId: playerRow?.id ?? null,
      reason: 'inactive',
      ip,
      userAgent,
    });
    if (playerRow && blockedPlayerStatus) {
      events.emit('player.login_blocked', {
        userId: account.id,
        playerId: playerRow.id,
        status: blockedPlayerStatus,
        ip,
        userAgent,
      });
    }
    throw new ORPCError('FORBIDDEN', {
      message: 'Your account is inactive. Contact your administrator.',
      data: errorData.inactive,
    });
  }

  if (playerRow && blockedPlayerStatus) {
    await revoke();
    events.emit('player.login_blocked', {
      userId: account.id,
      playerId: playerRow.id,
      status: blockedPlayerStatus,
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
