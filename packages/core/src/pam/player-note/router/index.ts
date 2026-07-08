import { implement } from '@orpc/server';
import { AdminGuard, type OssContext } from '@openora/core/server';
import { playerNoteContract } from '../contract/index.js';
import { PlayerNoteService } from '../service/player-note.service.js';

export function createPlayerNoteRouter(svc: PlayerNoteService, adminGuard: AdminGuard) {
  const os = implement(playerNoteContract).$context<OssContext>();

  return os.router({
    list: os.list.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'player-note', 'view');
      return svc.list(input.playerId, input.page, input.limit);
    }),

    create: os.create.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'player-note', 'create');
      return svc.create(input, caller.userId);
    }),
  });
}
