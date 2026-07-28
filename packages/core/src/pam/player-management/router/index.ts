import { implement } from '@orpc/server';
import { AdminGuard, mapErrors, type OssContext } from '@openora/core/server';
import type { AuditWritePort } from '@openora/core/contracts';
import { playerContract } from '../contract/index.js';
import { PlayerService, PlayerNotFoundError } from '../service/player.service.js';

export function createPlayerRouter(
  player: PlayerService,
  adminGuard: AdminGuard,
  audit: AuditWritePort,
) {
  const os = implement(playerContract).$context<OssContext>();

  return os.router({
    list: os.list.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'player', 'view');
      return player.list(input);
    }),

    get: os.get.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'player', 'view');
      return mapErrors({ NOT_FOUND: PlayerNotFoundError }, () => player.get(input.playerId));
    }),

    getByUserId: os.getByUserId.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'player', 'view');
      return mapErrors({ NOT_FOUND: PlayerNotFoundError }, () => player.getByUserId(input.userId));
    }),

    update: os.update.handler(async ({ input, context }) => {
      const { userId: adminId } = await adminGuard.assert(context, 'player', 'update');
      return mapErrors({ NOT_FOUND: PlayerNotFoundError }, async () => {
        const before = await player.get(input.playerId);
        // NOTE: `input.email` is accepted by the contract and by PlayerService.update's
        // signature but is NOT forwarded here - that gap predates this change (present
        // on `dev` too) and is out of scope for this fix; flagged, not silently patched.
        const updated = await player.update(
          input.playerId,
          {
            displayName: input.displayName,
            status: input.status,
            level: input.level,
          },
          adminId,
        );
        await audit.record({
          actorId: adminId,
          actorType: 'admin',
          action: 'admin.player.updated',
          resourceType: 'player',
          resourceId: input.playerId,
          before: {
            displayName: before.displayName,
            status: before.status,
            level: before.level,
            email: before.email,
          },
          after: {
            displayName: updated.displayName,
            status: updated.status,
            level: updated.level,
            email: updated.email,
          },
        });
        return updated;
      });
    }),

    remove: os.remove.handler(async ({ input, context }) => {
      const { userId: adminId } = await adminGuard.assert(context, 'player', 'ban');
      return mapErrors({ NOT_FOUND: PlayerNotFoundError }, async () => {
        const before = await player.get(input.playerId);
        const result = await player.remove(input.playerId);
        await audit.record({
          actorId: adminId,
          actorType: 'admin',
          action: 'admin.player.removed',
          resourceType: 'player',
          resourceId: input.playerId,
          before: { status: before.status },
          after: { status: 'closed' },
        });
        return result;
      });
    }),

    registrationsOverTime: os.registrationsOverTime.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'analytics', 'view');
      return player.registrationsOverTime(input.days ?? 30);
    }),

    summary: os.summary.handler(async ({ context }) => {
      await adminGuard.assert(context, 'analytics', 'view');
      return player.summary();
    }),
  });
}
