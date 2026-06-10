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
  'identity.2fa.enabled': z.object({ userId: z.string() }),
  'identity.2fa.disabled': z.object({ userId: z.string() }),
  'identity.password.reset': z.object({ userId: z.string() }),
  'identity.email.verified': z.object({ userId: z.string() }),
  'identity.profile.updated': z.object({ userId: z.string() }),

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

  'sportsbook.odds.updated': z.object({
    eventId: z.string(),
    selectionId: z.string(),
    odds: z.number(),
  }),
  'sportsbook.bet.placed': z.object({
    userId: z.string(),
    betId: z.string(),
    selectionId: z.string(),
    stake: z.number(),
  }),

  // Emitted when an admin invitation token is accepted. The consumer (identity
  // module or an overlay) provisions the user account and completes the role
  // assignment by resolving the userId from the email.
  'iam.invitation.accepted': z.object({
    email: z.string(),
    roleId: z.string(),
    invitationId: z.string(),
  }),
} as const;

export type DomainEventName = keyof typeof domainEventSchemas;
export type DomainEventPayload<K extends DomainEventName> = z.infer<(typeof domainEventSchemas)[K]>;

// Per-event schema version. Every event starts at 1; bump an entry here only when
// its payload shape changes in a non-additive way, in the SAME commit that edits
// the schema above. The EventBus stamps this onto the envelope's `schemaVersion`
// so a consumer (in another service, possibly deployed at a different version)
// can branch or upcast. Events not listed default to version 1 - keep the map
// sparse so it records only real evolutions, not noise.
export const domainEventVersions: Partial<Record<DomainEventName, number>> = {
  // 'wallet.deposit.completed': 2,  // example: bumped when `fee` was added
};

export function getEventVersion(event: string): number {
  return domainEventVersions[event as DomainEventName] ?? 1;
}

// Machine-readable catalog of every cross-module topic and its current version.
// Useful for provisioning broker topics (Kafka/RabbitMQ), docs, and asserting
// producer/consumer version agreement across services. Pure - no side effects.
export function eventCatalog(): ReadonlyArray<{ topic: DomainEventName; version: number }> {
  return (Object.keys(domainEventSchemas) as DomainEventName[]).map((topic) => ({
    topic,
    version: getEventVersion(topic),
  }));
}
