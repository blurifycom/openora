import { implement } from '@orpc/server';
import { type OssContext } from '@openora/core/server';
import { gamificationContract } from '../contract/index.js';
import { GamificationService } from '../service/gamification.service.js';

// oRPC router factory for Gamification. plugin.ts builds the service from the
// container and passes it here; each procedure delegates to the service. Keep this
// thin: resolve the caller, call the service, map domain errors - no business rules.
// Admin-only procedures MUST `await adminGuard.assert(context)` first (lint: require-admin-guard).
export function createGamificationRouter(gamification: GamificationService) {
  const os = implement(gamificationContract).$context<OssContext>();

  return os.router({
    list: os.list.handler(() => gamification.list()),

    // AGENT: add more procedures here. Define their shapes in this module's
    // contract/index.ts, never inline Zod here.
  });
}
