/**
 * Consumer Games Plugin - worked example of the overlay pattern.
 *
 * TO USE: add this plugin to extensions.config.ts:
 *
 *   import consumerGames from './examples/consumer-games-plugin/plugin.js';
 *   export default [consumerGames];
 *
 * See AGENTS.md for a full walkthrough.
 */

import { definePlugin } from '@oss/plugin-host';
import { GAME_ADAPTER } from '@oss/module-gaming';
import { CrashController } from './src/router/crash.router.js';
import { ConsumerGameAdapter } from './src/provider/consumer-game-provider.js';

export default definePlugin({
  id: 'consumer-games',
  dependsOn: ['gaming', 'wallet'],

  register(ctx) {
    // 1. Override the OSS mock game provider with Consumer's real one.
    //    Any code that injects GAME_ADAPTER will now get ConsumerGameAdapter.
    ctx.providers.add({ provide: GAME_ADAPTER, useClass: ConsumerGameAdapter });

    // 2. Mount the Crash game controller.
    //    Adds: POST /crash/rounds, POST /crash/bets,
    //          POST /crash/cash-out, GET /crash/rounds/current
    ctx.controllers.add(CrashController);

    // 3. Listen for wallet deposits - award 10 free spins on deposits >= $10.
    ctx.events.on('wallet.deposit.completed', async (payload: unknown) => {
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('userId' in payload) ||
        !('amount' in payload)
      ) {
        return;
      }

      const { userId, amount } = payload as { userId: string; amount: number };

      if (amount >= 10) {
        // In production: emit a 'bonus.free-spins.awarded' event via EventBus.
        console.log(`[consumer-games] Awarding 10 free spins to ${userId} for deposit of ${amount}`);
      }
    });

    // 4. Inject a custom game card into the lobby's game-lobby-extra slot.
    //    The UI provider renders whatever is in this slot below the standard game grid.
    ctx.slots.fill('game-lobby-extra', {
      type: 'crash-game-card',
      label: 'Crash',
      path: '/crash',
    });

    // 5. Extend the Prisma schema with Crash-specific tables.
    //    Run `pnpm regen` after enabling this plugin to apply migrations.
    ctx.prisma.extend(
      'CrashRound',
      `
      id         String   @id @default(cuid())
      tenantId   String
      multiplier Float
      bustedAt   DateTime
      status     String   @default("active")
      createdAt  DateTime @default(now())
    `,
    );
  },
});
