import { DRIZZLE, ADMIN_GUARD } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PlayerNoteService } from './service/player-note.service.js';
import { createPlayerNoteRouter } from './router/index.js';

export default {
  id: 'player-note',
  register(ctx) {
    ctx.routers.add('player-note', (c) =>
      createPlayerNoteRouter(new PlayerNoteService(c.get(DRIZZLE)), c.get(ADMIN_GUARD)),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;
