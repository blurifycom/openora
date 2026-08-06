import { DRIZZLE, ADMIN_GUARD } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { AUDIT_WRITER } from '@openora/core/contracts';
import { PlayerNoteService } from './service/player-note.service.js';
import { createPlayerNoteRouter } from './router/index.js';

export default {
  id: 'player-note',
  dependsOn: ['audit'],
  register(ctx) {
    ctx.routers.add('player-note', (c) =>
      createPlayerNoteRouter(
        new PlayerNoteService(c.get(DRIZZLE)),
        c.get(ADMIN_GUARD),
        c.get(AUDIT_WRITER),
      ),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;
