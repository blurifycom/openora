import { EVENT_BUS, DRIZZLE, ADMIN_GUARD } from '@openora/core/server';
import {
  AUDIT_WRITER,
  KYC_STATUS_WRITER,
  ADMIN_USER_DIRECTORY,
  ADMIN_GAME_REPORTING,
  CHAT_BLOCK_WRITER,
  SESSION_COMMANDS,
  USER_COMMANDS,
  PLAYER_ACTIVITY_TRACKER,
  PLAYER_ACCOUNT_MANAGER_READER,
  McpToolError,
  EXCHANGE_RATE_READER,
  JOB_QUEUE,
  domainEventSchemas,
  queue,
  UuidSchema,
} from '@openora/core/contracts';
import type { JobQueueAdapter } from '@openora/core/contracts';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import * as z from 'zod';
import { PlayerService, PlayerNotFoundError } from './service/player.service.js';
import { PlayerKycStatusWriter } from './service/kyc-status-writer.js';
import { AccountManagerService } from './service/account-manager.service.js';
import { createPlayerRouter } from './router/index.js';
import { playerSummaryTool } from './contract/agent-tools.js';

function makePlayerService(c: TypedContainer<CoreTokenCatalog>) {
  return new PlayerService(
    c.get(DRIZZLE),
    c.get(EVENT_BUS),
    c.get(ADMIN_USER_DIRECTORY),
    c.get(ADMIN_GAME_REPORTING),
    c.get(CHAT_BLOCK_WRITER),
    c.get(SESSION_COMMANDS),
    c.get(USER_COMMANDS),
    c.has(EXCHANGE_RATE_READER) ? c.get(EXCHANGE_RATE_READER) : undefined,
  );
}

const TOTAL_DEPOSITS_QUEUE = queue('player-total-deposits');
const TotalDepositsJobSchema = z.object({ userId: UuidSchema });

export default {
  id: 'player-management',
  dependsOn: ['chat', 'gaming', 'audit', 'identity'],
  register(ctx) {
    // One memoized instance backs the tracker port, the router and the deposit job.
    let svc: PlayerService | null = null;
    let jobQueue: JobQueueAdapter | null = null;
    const playerService = (c: TypedContainer<CoreTokenCatalog>) => {
      jobQueue ??= c.get(JOB_QUEUE);
      return (svc ??= makePlayerService(c));
    };
    let accountManagers: AccountManagerService | null = null;
    const accountManagerService = (c: TypedContainer<CoreTokenCatalog>) =>
      (accountManagers ??= new AccountManagerService({
        drizzle: c.get(DRIZZLE),
        events: c.get(EVENT_BUS),
        audit: c.get(AUDIT_WRITER),
        adminGuard: c.get(ADMIN_GUARD),
      }));

    // The refresh recomputes from the ledger, so it runs as a retryable job: a failed read or
    // an unpriced currency retries instead of leaving totalDeposits stale until the next deposit.
    // Awaited and thrown: a failed enqueue leaves the event pending for redelivery (ADR-0045).
    ctx.events.on('wallet.deposit.completed', async (payload) => {
      const parsed = domainEventSchemas['wallet.deposit.completed'].safeParse(payload);
      if (!parsed.success) {
        return;
      }
      if (!jobQueue) {
        throw new Error('player total deposits - job queue not bound yet');
      }
      await jobQueue.enqueue(
        TOTAL_DEPOSITS_QUEUE,
        { userId: parsed.data.userId },
        {
          idempotencyKey: `player-total-deposits:${parsed.data.transactionId}`,
          orderingKey: parsed.data.userId,
          attempts: 10,
          backoff: { type: 'exponential', delayMs: 1_000 },
        },
      );
    });
    ctx.jobs.worker({
      queue: TOTAL_DEPOSITS_QUEUE,
      schema: TotalDepositsJobSchema,
      options: { serializeByOrderingKey: true },
      handler: async ({ payload }) => {
        if (!svc) {
          throw new Error('player service is not initialized');
        }
        if (!(await svc.refreshTotalDeposits(payload.userId))) {
          throw new Error('could not price every deposit currency');
        }
      },
    });

    ctx.provide(KYC_STATUS_WRITER, (c) => new PlayerKycStatusWriter(c.get(DRIZZLE)));
    ctx.provide(PLAYER_ACTIVITY_TRACKER, playerService);
    ctx.provide(PLAYER_ACCOUNT_MANAGER_READER, accountManagerService);
    ctx.routers.add('player', (c) =>
      createPlayerRouter({
        player: playerService(c),
        accountManagers: accountManagerService(c),
        adminGuard: c.get(ADMIN_GUARD),
        audit: c.get(AUDIT_WRITER),
      }),
    );
    ctx.mcp.tool(playerSummaryTool, (c) => {
      const players = makePlayerService(c);
      return async ({ playerId }) => {
        try {
          const { id, ...detail } = await players.get(playerId);
          return { playerId: id, ...detail };
        } catch (err) {
          throw err instanceof PlayerNotFoundError ? new McpToolError('player_not_found') : err;
        }
      };
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
