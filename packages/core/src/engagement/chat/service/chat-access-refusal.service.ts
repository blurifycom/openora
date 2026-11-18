import { createLogger, type EventBus } from '@openora/core/server';
import type { Account, AccountReader, ClientMeta, Uuid } from '@openora/core/contracts';

const logger = createLogger('chat-access-refusal');

// A chat-level refusal never reaches a shared guard, so it owes the audit log AdminGuard's signal.
// The refusal is recorded even when the caller's account cannot be read, just without its role.
export async function emitAccessRefused(
  accounts: AccountReader,
  events: EventBus,
  {
    actorId,
    resource,
    action,
    ip,
    userAgent,
  }: { actorId: Uuid; resource: string; action: string } & ClientMeta,
) {
  const caller = await accounts
    .getAccounts([actorId])
    .then((found) => found.get(actorId))
    .catch((err: unknown): Account | undefined => {
      logger.warn({ err, actorId }, 'account read failed for an access refusal');
      return undefined;
    });
  events.emit('identity.user.unauthorized_access', {
    userId: actorId,
    playerId: caller?.player?.playerId ?? null,
    resource,
    action,
    ...(caller?.role ? { role: caller.role } : {}),
    ip: ip ?? null,
    userAgent: userAgent ?? null,
  });
}
