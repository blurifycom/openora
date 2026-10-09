import { eq } from 'drizzle-orm';
import type { DrizzleDb, DrizzleTx, EventBus } from '@openora/core/server';
import type { ClientMeta, Uuid } from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';

// A chat-level refusal never reaches a shared guard, so it owes the audit log AdminGuard's signal.
export async function emitAccessRefused(
  db: DrizzleDb | DrizzleTx,
  events: EventBus,
  {
    actorId,
    resource,
    action,
    ip,
    userAgent,
  }: { actorId: Uuid; resource: string; action: string } & ClientMeta,
) {
  const [caller] = await db
    .select({ role: user.role, playerId: player.id })
    .from(user)
    .leftJoin(player, eq(player.userId, user.id))
    .where(eq(user.id, actorId))
    .limit(1);
  events.emit('identity.user.unauthorized_access', {
    userId: actorId,
    playerId: caller?.playerId ?? null,
    resource,
    action,
    ...(caller?.role ? { role: caller.role } : {}),
    ip: ip ?? null,
    userAgent: userAgent ?? null,
  });
}
