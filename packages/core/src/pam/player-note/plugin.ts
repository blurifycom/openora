import { DRIZZLE, ADMIN_GUARD } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import { AUDIT_WRITER, McpToolError, runActorAdminId } from '@openora/core/contracts';
import { PlayerNoteService, PlayerNotFoundError } from './service/player-note.service.js';
import { createPlayerNoteRouter } from './router/index.js';
import { addNoteAction } from './contract/agent-tools.js';

function makePlayerNoteService(c: TypedContainer<CoreTokenCatalog>) {
  return new PlayerNoteService(c.get(DRIZZLE), c.get(AUDIT_WRITER));
}

export default {
  id: 'player-note',
  dependsOn: ['audit'],
  register(ctx) {
    ctx.routers.add('player-note', (c) =>
      createPlayerNoteRouter(makePlayerNoteService(c), c.get(ADMIN_GUARD), c.get(AUDIT_WRITER)),
    );
    ctx.actions.register(addNoteAction, (c) => {
      const notes = makePlayerNoteService(c);
      return {
        precondition: async ({ playerId }) =>
          (await notes.playerExists(playerId))
            ? { ok: true }
            : { ok: false, code: 'player_not_found' },
        execute: async ({ playerId, content }, proposalId, actor) => {
          try {
            const result = await notes.createForProposal({
              playerId,
              content,
              actorId: runActorAdminId(actor),
              proposalId,
            });
            return result.status === 'created'
              ? { outcome: 'applied', detail: { noteId: result.note.id } }
              : { outcome: 'already_applied' };
          } catch (err) {
            throw err instanceof PlayerNotFoundError ? new McpToolError('player_not_found') : err;
          }
        },
      };
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
