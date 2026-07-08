import { definePlugin, DRIZZLE, ADMIN_GUARD } from '@openora/core/server';
import { PlayerNoteService } from './service/player-note.service.js';
import { createPlayerNoteRouter } from './router/index.js';

export default definePlugin({
  id: 'player-note',
  register(ctx) {
    ctx.routers.add('player-note', (c) =>
      createPlayerNoteRouter(new PlayerNoteService(c.get(DRIZZLE)), c.get(ADMIN_GUARD)),
    );
  },
});
