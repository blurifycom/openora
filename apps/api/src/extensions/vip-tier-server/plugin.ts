// Reference overlay: a working example demonstrating three of the four
// extension axes of the plugin host - `provide`, `routers.add`, `events.on`.
// (MCP tool axis omitted from this overlay for surface-area simplicity; see
// other modules for that pattern.)
//
// Reads on `wallet.deposit.completed` events to track VIP tier progression
// without touching the wallet module.
//
// PAIRED with the client `@oss/example-vip-tier` UI plugin: both share the
// id stem `vip-tier`. The server overlay surfaces routes + event handling;
// the UI plugin surfaces slots, gating, and page-context consumption.
//
// This overlay is registered LAST in `extensions.config.ts` so it can react
// to events emitted by the wallet module.

import { definePlugin, type RouterFactory } from '@oss/plugin-host';
import { createLogger } from '@oss/core';
import { createToken, type Token } from '@oss/adapters';
import { os } from '@orpc/server';
import { z } from 'zod';
import type { DomainEventPayload } from '@oss/shared-schemas';

const log = createLogger('vip-tier-server');

const VipTierSchema = z.object({
  playerId: z.string(),
  tier: z.enum(['BRONZE', 'SILVER', 'GOLD', 'PLATINUM']),
  points: z.number().int().nonnegative(),
});

type VipTier = z.infer<typeof VipTierSchema>;

interface VipTierService {
  getByPlayer(playerId: string): Promise<VipTier>;
  recordDeposit(playerId: string, amount: number): Promise<void>;
}

const VIP_TIER_SERVICE: Token<VipTierService> = createToken<VipTierService>('VIP_TIER_SERVICE');

class InMemoryVipTierService implements VipTierService {
  private points = new Map<string, number>();

  async getByPlayer(playerId: string): Promise<VipTier> {
    const pts = this.points.get(playerId) ?? 0;
    return { playerId, tier: tierFor(pts), points: pts };
  }

  async recordDeposit(playerId: string, amount: number): Promise<void> {
    const next = (this.points.get(playerId) ?? 0) + Math.floor(amount);
    this.points.set(playerId, next);
  }
}

function tierFor(points: number): VipTier['tier'] {
  if (points >= 100_000) return 'PLATINUM';
  if (points >= 25_000) return 'GOLD';
  if (points >= 5_000) return 'SILVER';
  return 'BRONZE';
}

// Singleton kept in module scope so the event handler and the router resolve
// to the SAME instance (deposits tracked by the event handler are visible to
// the route reader).
const serviceInstance = new InMemoryVipTierService();

const buildRouter: RouterFactory = (c) => {
  const service = c.get(VIP_TIER_SERVICE);
  return {
    getByPlayer: os
      .route({ method: 'GET', path: '/vip-tier/{playerId}' })
      .input(z.object({ playerId: z.string() }))
      .output(VipTierSchema)
      .handler(({ input }: { input: { playerId: string } }) => service.getByPlayer(input.playerId)),
  };
};

export default definePlugin({
  id: 'vip-tier-server',
  register(ctx) {
    ctx.provide(VIP_TIER_SERVICE, () => serviceInstance);
    ctx.routers.add('vipTier', buildRouter);
    ctx.events.on('wallet.deposit.completed', async (raw) => {
      const payload = raw as DomainEventPayload<'wallet.deposit.completed'>;
      await serviceInstance.recordDeposit(payload.userId, payload.amount);
      log.info({ userId: payload.userId, amount: payload.amount }, 'vip-tier deposit tracked');
    });
  },
});
