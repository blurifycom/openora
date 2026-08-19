import { implement } from '@orpc/server';
import { AdminGuard, mapErrors, getUserId, type OssContext } from '@openora/core/server';
import type { AuditWritePort } from '@openora/core/contracts';
import { playerContract } from '../contract/index.js';
import {
  DuplicateUsernameError,
  PlayerService,
  PlayerNotFoundError,
} from '../service/player.service.js';

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
      return mapErrors(
        { NOT_FOUND: PlayerNotFoundError, CONFLICT: DuplicateUsernameError },
        async () => {
          const before = await player.get(input.playerId);
          const updated = await player.update(
            input.playerId,
            {
              username: input.username,
              status: input.status,
              level: input.level,
              email: input.email,
            },
            adminId,
          );
          if (input.username !== undefined && input.username !== before.username) {
            await audit.record({
              actorId: adminId,
              actorType: 'admin',
              action: 'admin.player.username_corrected',
              resourceType: 'player',
              resourceId: input.playerId,
              before: { username: before.username },
              after: { username: updated.username },
            });
          }
          await audit.record({
            actorId: adminId,
            actorType: 'admin',
            action: 'admin.player.updated',
            resourceType: 'player',
            resourceId: input.playerId,
            before: {
              status: before.status,
              level: before.level,
              email: before.email,
            },
            after: {
              status: updated.status,
              level: updated.level,
              email: updated.email,
            },
          });
          return updated;
        },
      );
    }),

    remove: os.remove.handler(async ({ input, context }) => {
      const { userId: adminId } = await adminGuard.assert(context, 'player', 'ban');
      return mapErrors({ NOT_FOUND: PlayerNotFoundError }, async () => {
        const before = await player.get(input.playerId);
        const result = await player.remove(input.playerId, adminId);
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

    // Player-facing (not adminGuard-gated) - powers the chat `/profile` command,
    // same as the routes this replaces in chat-commands.
    playerSearch: os.playerSearch.handler(({ input, context }) => {
      const viewerId = getUserId(context);
      return player.searchPlayers(input.q, input.limit, viewerId);
    }),

    playerProfile: os.playerProfile.handler(({ input, context }) => {
      const viewerId = getUserId(context);
      return mapErrors({ NOT_FOUND: PlayerNotFoundError }, () =>
        player.getPlayerProfile(input.userId, viewerId),
      );
    }),
  });
}
