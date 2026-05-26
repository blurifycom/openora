import { KYC_ADAPTER } from '@oss/adapters';
import { definePlugin } from '@oss/plugin-host';
import { MockKycAdapter } from './adapters/mock/mock-kyc-adapter.js';
import { IdentityController } from './router/index.js';
import { IdentityService } from './service/identity.service.js';

export default definePlugin({
  id: 'identity',
  register(ctx) {
    ctx.providers.add(IdentityService);
    ctx.controllers.add(IdentityController);
    ctx.providers.add({ provide: KYC_ADAPTER, useClass: MockKycAdapter });
  },
});
