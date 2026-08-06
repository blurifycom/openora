import { implement } from '@orpc/server';
import { AdminGuard, type OssContext } from '@openora/core/server';
import type { AuditWritePort } from '@openora/core/contracts';
import { playerNoteContract } from '../contract/index.js';
import { PlayerNoteService } from '../service/player-note.service.js';

export function createPlayerNoteRouter(
  svc: PlayerNoteService,
  adminGuard: AdminGuard,
  audit: AuditWritePort,
) {
  const os = implement(playerNoteContract).$context<OssContext>();

  return os.router({
    list: os.list.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'player-note', 'view');
      return svc.list({
        playerId: input.playerId,
        page: input.page,
        limit: input.limit,
        sortBy: input.sortBy,
        sortOrder: input.sortOrder,
      });
    }),

    create: os.create.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'player-note', 'create');
      const created = await svc.create(input, caller.userId);
      await audit.record({
        actorId: caller.userId,
        actorType: 'admin',
        action: 'admin.player_note.created',
        resourceType: 'player',
        resourceId: input.playerId,
        after: { noteId: created.id, content: created.content },
        ip: caller.ip,
        userAgent: caller.userAgent,
      });
      return created;
    }),
  });
}
