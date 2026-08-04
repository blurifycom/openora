import {
  ADMIN_GAME_REPORTING,
  ADMIN_PLAYER_ACTIVITY,
  ADMIN_USER_DIRECTORY,
  ADMIN_WALLET_REPORTING,
  AUDIT_WRITER,
} from '@openora/core/contracts';
import { definePluginWithCatalog, ADMIN_GUARD, type CoreTokenCatalog } from '@openora/core/server';
import { BackofficeService } from './service/backoffice.service.js';
import { createBackofficeRouter } from './router/index.js';

export default definePluginWithCatalog<CoreTokenCatalog>()({
  id: 'admin-console',
  dependsOn: ['identity', 'wallet', 'audit', 'gaming', 'iam'],
  register(ctx) {
    ctx.routers.add('backoffice', (c) =>
      createBackofficeRouter(
        new BackofficeService(
          c.get(ADMIN_USER_DIRECTORY),
          c.get(ADMIN_WALLET_REPORTING),
          c.get(ADMIN_GAME_REPORTING),
          c.get(ADMIN_PLAYER_ACTIVITY),
        ),
        c.get(ADMIN_GUARD),
        c.get(AUDIT_WRITER),
      ),
    );
  },
});
