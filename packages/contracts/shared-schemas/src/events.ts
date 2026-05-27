import * as z from 'zod';

// The cross-module domain event catalog: one Zod schema per event topic. This is
// the single source of truth for both the runtime payload validation and the
// inferred payload type (`DomainEventPayload`). A module that emits or subscribes
// to a cross-module event declares its shape here so producers and consumers share
// one contract. Payloads are intentionally small (ids + primitives); compose an
// existing shared-schema here if a future event carries a full entity.
//
// Keep this in sync with the `events.emit(...)` call sites in
// packages/modules/**/src/service/*.service.ts.
export const domainEventSchemas = {
  'identity.user.registered': z.object({ userId: z.string() }),
  'identity.user.login': z.object({ userId: z.string() }),

  'wallet.deposit.completed': z.object({
    userId: z.string(),
    amount: z.number(),
    currency: z.string(),
    transactionId: z.string(),
  }),
  'wallet.withdrawal.completed': z.object({
    userId: z.string(),
    amount: z.number(),
    currency: z.string(),
    transactionId: z.string(),
  }),

  'gaming.round.started': z.object({
    roundId: z.string(),
    gameId: z.string(),
    userId: z.string(),
    currency: z.string(),
  }),
  'gaming.round.ended': z.object({ roundId: z.string(), userId: z.string() }),

  'bonus.claimed': z.object({
    userId: z.string(),
    bonusId: z.string(),
    userBonusId: z.string(),
  }),

  'chat.message.sent': z.object({
    messageId: z.string(),
    roomId: z.string(),
    userId: z.string(),
  }),

  'compliance.limit.upserted': z.object({ userId: z.string(), limitId: z.string() }),
  'compliance.limit.removed': z.object({ userId: z.string(), limitId: z.string() }),

  'notifications.created': z.object({ notificationId: z.string(), userId: z.string() }),

  'localization.translation.upserted': z.object({
    locale: z.string(),
    namespace: z.string(),
    key: z.string(),
  }),
  'localization.translation.deleted': z.object({ id: z.string() }),

  'cms.page.published': z.object({ pageId: z.string(), slug: z.string() }),

  'aggregator.sync.completed': z.object({
    synced: z.number(),
    failed: z.number(),
    tenantId: z.string(),
  }),
  'aggregator.callback.received': z.object({ provider: z.string(), event: z.string() }),

  'leaderboard.score.recorded': z.object({
    userId: z.string(),
    metric: z.string(),
    amount: z.number(),
    tenantId: z.string(),
  }),
  'leaderboard.reset': z.object({
    metric: z.string(),
    period: z.string(),
    tenantId: z.string(),
  }),
} as const;

export type DomainEventName = keyof typeof domainEventSchemas;
export type DomainEventPayload<K extends DomainEventName> = z.infer<(typeof domainEventSchemas)[K]>;
