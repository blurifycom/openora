import { KYC_ADAPTER } from '@oss/adapters';
import { definePlugin } from '@oss/plugin-host';
import { EVENT_BUS } from '@oss/core';
import { DRIZZLE } from '@oss/db';
import { MockKycAdapter } from './adapters/mock/mock-kyc-adapter.js';
import { createIdentityRouter } from './router/index.js';
import { IdentityService } from './service/identity.service.js';

export default definePlugin({
  id: 'identity',
  register(ctx) {
    ctx.provide(KYC_ADAPTER, () => new MockKycAdapter());
    ctx.routers.add('identity', (c) =>
      createIdentityRouter(new IdentityService(c.get(DRIZZLE), c.get(EVENT_BUS))),
    );
  },
});
