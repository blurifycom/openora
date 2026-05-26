import { definePlugin } from '@oss/plugin-host';
import { IdentityService } from './service/identity.service.js';
import { IdentityController } from './router/index.js';

export default definePlugin({
  id: 'identity',
  register(ctx) {
    ctx.providers.add(IdentityService);
    ctx.controllers.add(IdentityController);
  },
});
