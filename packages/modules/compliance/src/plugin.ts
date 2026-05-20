import { definePlugin } from '@oss/plugin-host';
import { ComplianceService } from './service/compliance.service.js';
import { ComplianceController } from './router/index.js';

export default definePlugin({
  id: 'compliance',
  register(ctx) {
    ctx.providers.add(ComplianceService);
    ctx.controllers.add(ComplianceController);
  },
});
