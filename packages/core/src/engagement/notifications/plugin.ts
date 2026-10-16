import * as z from 'zod';
import {
  GEO_CHECK_COMMANDS,
  IDENTITY_READER,
  JOB_QUEUE,
  MAIL_DISPATCH,
  MailTemplateSchema,
  PLATFORM_CONFIG,
  PLAY_ELIGIBILITY,
  REALTIME_TRANSPORT,
  TimestampSchema,
  UuidSchema,
  domainEventSchemas,
  queue,
  type DomainEventName,
  type DomainEventPayload,
  type GeoCheckCommands,
  type IdentityReader,
  type JobQueueAdapter,
  type MailDispatchPort,
  type MailTemplate,
  type PlayEligibilityPort,
  type RealtimeTransport,
} from '@openora/core/contracts';
import { createLogger, EVENT_BUS, DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  createNotificationsRouter,
  notificationsChannel,
  toNotificationDto,
} from './router/index.js';
import { NotificationsService } from './service/notifications.service.js';
import {
  QueuedNotificationInputSchema,
  type CreateNotificationInput,
  type NOTIFICATION_PARAM_KEYS,
  type NotificationData,
  type NotificationType,
} from './contract/index.js';

const KYC_RESUBMISSION_NOTIFY_QUEUE = queue('kyc-resubmission-notify');
const NOTIFICATIONS_RETENTION_PURGE_QUEUE = queue('notifications-retention-purge');
const NOTIFICATIONS_DISPATCH_QUEUE = queue('notifications-dispatch');
const SECURITY_ALERT_DISPATCH_QUEUE = queue('security-alert-dispatch');

const DEFAULT_NOTIFICATIONS_RETENTION_DAYS = 30;
const DEFAULT_NOTIFICATIONS_RETENTION_CRON = '0 3 * * *';

const KycResubmissionNotifyJobSchema = z.object({
  userId: UuidSchema,
  reason: z.string().nullable(),
  eventId: UuidSchema.optional(),
});

const NotificationDispatchJobSchema = z.object({
  event: z.string(),
  input: QueuedNotificationInputSchema,
  email: MailTemplateSchema.nullish(),
  // Backlog jobs produced before security alerts existed omit this field.
  securityAlert: z.boolean().default(false),
});

const SecurityAlertDispatchJobSchema = z.object({
  userId: UuidSchema,
  eventId: UuidSchema,
  occurredAt: TimestampSchema,
});

type NotificationMapEntry = {
  event: DomainEventName;
  parse: (payload: unknown) => unknown;
  buildNotification: (data: unknown) => CreateNotificationInput;
  buildEmail: (data: unknown, occurredAt: string) => MailTemplate | null;
  // Opt-in security alert: the mail is preference-gated and its enqueue errors reach the worker.
  securityAlert: boolean;
};

// Drops null/undefined values (eg a nullable roomId) so `data` and `params` only ever carry
// fields the source event actually had a value for; an all-null payload becomes `null`.
function compactData(
  fields: Record<string, string | null | undefined>,
): Record<string, string> | null {
  const entries = Object.entries(fields).filter(
    (entry): entry is [string, string] => entry[1] !== null && entry[1] !== undefined,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

type ParamKeys<T extends NotificationType> = (typeof NOTIFICATION_PARAM_KEYS)[T];

// Every required key of the type and any of its optional ones - a key outside the type's set is a
// compile error, so the map below cannot drift from NOTIFICATION_PARAM_KEYS. A type with no keys
// takes `Record<string, never>`: an empty `{}` target would skip the excess-key check.
type NotificationParamsOf<T extends NotificationType> = [
  ParamKeys<T>['required'][number] | ParamKeys<T>['optional'][number],
] extends [never]
  ? Record<string, never>
  : Record<ParamKeys<T>['required'][number], string> &
      Partial<Record<ParamKeys<T>['optional'][number], string | null>>;

// The previous release's dispatch worker still requires these strings on a queued job; they are
// stripped on read here. ponytail: remove together with the title/body columns.
const LEGACY_DISPATCH_TEXT = { title: '', body: '' } as const;

function notification<T extends NotificationType>(input: {
  userId: string;
  type: T;
  params: NotificationParamsOf<T>;
  data?: NotificationData | null;
}): CreateNotificationInput {
  return {
    userId: input.userId,
    type: input.type,
    params: compactData(input.params),
    data: input.data ?? null,
  };
}

// A plain array literal would widen every entry's `event` to DomainEventName and lose the
// payload type tied to it; this generic keeps K bound per entry so buildNotification stays
// checked against that one event's actual payload shape.
function mapEvent<K extends DomainEventName>(
  event: K,
  buildNotification: (payload: DomainEventPayload<K>) => CreateNotificationInput,
  options?: {
    email: (payload: DomainEventPayload<K>, occurredAt: string) => MailTemplate | null;
    securityAlert?: boolean;
  },
): NotificationMapEntry {
  return {
    event,
    parse: (payload) => {
      const parsed = domainEventSchemas[event].safeParse(payload);
      return parsed.success ? parsed.data : null;
    },
    buildNotification: (data) => buildNotification(data as DomainEventPayload<K>),
    buildEmail: (data, occurredAt) =>
      options?.email ? options.email(data as DomainEventPayload<K>, occurredAt) : null,
    securityAlert: options?.securityAlert ?? false,
  };
}

export const notificationEventMap: NotificationMapEntry[] = [
  mapEvent(
    'wallet.withdrawal.approved',
    (p) =>
      notification({
        userId: p.userId,
        type: 'withdrawal.approved',
        params: { amount: p.amount, currency: p.currency },
        data: { transactionId: p.transactionId },
      }),
    {
      email: (p, occurredAt) => ({
        key: 'withdrawalApproved',
        data: {
          amount: p.amount,
          currency: p.currency,
          transactionId: p.transactionId,
          occurredAt,
        },
      }),
    },
  ),

  mapEvent(
    'wallet.withdrawal.rejected',
    (p) =>
      notification({
        userId: p.userId,
        type: 'withdrawal.rejected',
        params: { amount: p.amount, currency: p.currency, reason: p.reason || null },
        data: { transactionId: p.transactionId },
      }),
    {
      email: (p, occurredAt) => ({
        key: 'withdrawalRejected',
        data: {
          amount: p.amount,
          currency: p.currency,
          transactionId: p.transactionId,
          occurredAt,
          reason: p.reason,
        },
      }),
    },
  ),

  mapEvent(
    'wallet.withdrawal.requested',
    (p) =>
      notification({
        userId: p.userId,
        type: 'withdrawal.requested',
        params: { amount: p.amount, currency: p.currency },
        data: { transactionId: p.transactionId },
      }),
    {
      email: (p, occurredAt) => ({
        key: 'securityWithdrawalRequested',
        data: {
          amount: p.amount,
          currency: p.currency,
          transactionId: p.transactionId,
          occurredAt,
        },
      }),
    },
  ),

  mapEvent(
    'wallet.withdrawal.completed',
    (p) =>
      notification({
        userId: p.userId,
        type: 'withdrawal.completed',
        params: { amount: p.amount, currency: p.currency },
        data: { transactionId: p.transactionId },
      }),
    {
      email: (p, occurredAt) => ({
        key: 'withdrawalCompleted',
        data: {
          amount: p.amount,
          currency: p.currency,
          transactionId: p.transactionId,
          occurredAt,
        },
      }),
    },
  ),

  mapEvent(
    'wallet.withdrawal.failed',
    (p) =>
      notification({
        userId: p.userId,
        type: 'withdrawal.failed',
        params: { amount: p.amount, currency: p.currency },
        data: { transactionId: p.transactionId },
      }),
    {
      email: (p, occurredAt) => ({
        key: 'withdrawalFailed',
        data: {
          amount: p.amount,
          currency: p.currency,
          transactionId: p.transactionId,
          occurredAt,
        },
      }),
    },
  ),

  mapEvent(
    'wallet.deposit.completed',
    (p) =>
      notification({
        userId: p.userId,
        type: 'deposit.completed',
        params: { amount: p.amount, currency: p.currency },
        data: { transactionId: p.transactionId },
      }),
    {
      email: (p, occurredAt) => ({
        key: 'depositCompleted',
        data: {
          amount: p.amount,
          currency: p.currency,
          transactionId: p.transactionId,
          occurredAt,
        },
      }),
    },
  ),

  mapEvent(
    'wallet.deposit.held',
    (p) =>
      notification({
        userId: p.userId,
        type: 'deposit.held',
        params: { amount: p.amount, currency: p.currency },
        data: { transactionId: p.transactionId },
      }),
    {
      email: (p, occurredAt) => ({
        key: 'depositHeld',
        data: {
          amount: p.amount,
          currency: p.currency,
          transactionId: p.transactionId,
          occurredAt,
        },
      }),
    },
  ),

  // The admin's `reason` is internal: it is never copied into what the player sees.
  mapEvent('wallet.manual_adjustment.created', (p) =>
    notification({
      userId: p.userId,
      type: 'balance.adjusted',
      params: { direction: p.direction, amount: p.amount, currency: p.currency },
      data: { transactionId: p.transactionId },
    }),
  ),

  mapEvent(
    'promo.bonus.granted',
    (p) =>
      notification({
        userId: p.userId,
        type: 'promo.bonus.granted',
        params: {
          grantedAmount: p.grantedAmount,
          wageringRequired: p.wageringRequired,
          currency: p.currency,
          rankBonusKind: p.rankBonusKind,
          source: p.source,
        },
        data: { grantId: p.grantId },
      }),
    {
      // A gift or rain comes from another player and is already announced where it happened;
      // a rain fans out to a whole room, so a mail per recipient would be noise.
      email: (p) =>
        p.source === 'gift' || p.source === 'rain'
          ? null
          : {
              key: 'bonusCredited',
              data: {
                grantedAmount: p.grantedAmount,
                wageringRequired: p.wageringRequired,
                currency: p.currency,
              },
            },
    },
  ),

  mapEvent(
    'promo.bonus.completed',
    (p) =>
      notification({
        userId: p.userId,
        type: 'promo.bonus.completed',
        params: { amount: p.convertedAmount, currency: p.currency },
        data: { grantId: p.grantId },
      }),
    {
      email: (p) => ({
        key: 'bonusUnlocked',
        data: { convertedAmount: p.convertedAmount, currency: p.currency },
      }),
    },
  ),

  mapEvent('promo.bonus.forfeited', (p) =>
    notification({
      userId: p.userId,
      type: 'promo.bonus.forfeited',
      params: { amount: p.forfeitedAmount, currency: p.currency, reason: p.reason },
      data: { grantId: p.grantId },
    }),
  ),

  mapEvent('promo.bonus.expired', (p) =>
    notification({
      userId: p.userId,
      type: 'promo.bonus.expired',
      params: { amount: p.forfeitedAmount, currency: p.currency },
      data: { grantId: p.grantId },
    }),
  ),

  mapEvent(
    'promo.race.won',
    (p) =>
      notification({
        userId: p.userId,
        type: 'promo.race.won',
        params: {
          position: String(p.position),
          raceName: p.raceName,
          amount: p.amount,
          currency: p.currency,
        },
        data: { raceId: p.raceId },
      }),
    {
      email: (p) => ({
        key: 'raceWon',
        data: {
          raceName: p.raceName,
          position: p.position,
          amount: p.amount,
          currency: p.currency,
        },
      }),
    },
  ),

  mapEvent(
    'promo.rank-challenge.won',
    (p) =>
      notification({
        userId: p.userId,
        type: 'promo.rank-challenge.won',
        params: {
          tierName: p.tierName,
          cashAmount: p.cashAmount,
          physicalItem: p.physicalItem,
          currency: p.currency,
        },
        data: { tierId: p.tierId },
      }),
    {
      email: (p) => ({
        key: 'rankChallengeWon' as const,
        data: {
          tierName: p.tierName,
          cashAmount: p.cashAmount,
          physicalItem: p.physicalItem,
          currency: p.currency,
        },
      }),
    },
  ),

  mapEvent('promo.rank.changed', (p) =>
    notification({
      userId: p.userId,
      type: 'promo.rank.changed',
      params: {
        tierName: p.tierName,
        currency: p.currency,
        rakebackPercent: p.rakebackPercent,
        levelUpBonus: p.levelUpBonus,
        dailyBonus: p.dailyBonus,
        weeklyBonus: p.weeklyBonus,
        monthlyBonus: p.monthlyBonus,
      },
      data: { tierId: p.tierId },
    }),
  ),

  mapEvent('promo.streak.milestone.reached', (p) =>
    notification({
      userId: p.userId,
      type: 'promo.streak.milestone.reached',
      params: { day: String(p.day) },
      data: { day: String(p.day) },
    }),
  ),

  mapEvent('chat.user.mentioned', (p) =>
    notification({
      userId: p.mentionedUserId,
      type: 'chat.mention',
      params: {},
      data: compactData({ roomId: p.roomId, messageId: p.messageId }),
    }),
  ),

  mapEvent('chat.room.invite.sent', (p) =>
    notification({
      userId: p.inviteeId,
      type: 'chat.room_invite.received',
      params: { inviterUsername: p.inviterUsername, roomName: p.roomName },
      data: {
        inviteId: p.inviteId,
        roomId: p.roomId,
        inviterId: p.inviterId,
        roomName: p.roomName,
      },
    }),
  ),

  // Pre-existing types: in-app only, unchanged from before the declarative-map refactor.
  mapEvent('social.friend_request.sent', (p) =>
    notification({
      userId: p.addresseeId,
      type: 'social.friend_request.received',
      params: { requesterUsername: p.requesterUsername },
      data: { requesterId: p.requesterId },
    }),
  ),

  mapEvent('social.friend_request.accepted', (p) =>
    notification({
      userId: p.requesterId,
      type: 'social.friend_request.accepted',
      params: { accepterUsername: p.accepterUsername },
      // accepterId, not requesterId: the recipient of THIS notification is the
      // requester, so the linkable "other party" is whoever just accepted.
      data: { accepterId: p.accepterId },
    }),
  ),

  // In-app only: no `email` option passed to mapEvent, same as every other
  // no-mail entry above (the old boolean `{ sendEmail: false }` shape no longer exists).
  mapEvent('chat.room.ownership.transferred', (p) =>
    notification({
      userId: p.newOwnerId,
      type: 'chat.room.ownership_transferred',
      params: { roomName: p.roomName },
      data: { roomId: p.roomId },
    }),
  ),
];

export function buildKycResubmissionNotification(payload: {
  userId: string;
  reason: string | null;
}): CreateNotificationInput {
  return notification({
    userId: payload.userId,
    type: 'kyc.resubmission_requested',
    params: { reason: payload.reason || null },
  });
}

export function buildChatRoomScheduledForDeletionNotification(payload: {
  userId: string;
  roomId: string;
  roomName: string;
}): CreateNotificationInput {
  return notification({
    userId: payload.userId,
    type: 'chat.room.scheduled_for_deletion',
    params: { roomName: payload.roomName },
    data: { roomId: payload.roomId },
  });
}

// The admin's `reason` is internal: it is never copied into what the player sees.
export function buildRgLimitAdminUpdatedNotification(
  p: DomainEventPayload<'rg.limit.set'>,
): CreateNotificationInput {
  return notification({
    userId: p.userId,
    type: 'rg.limit.admin_updated',
    params: {
      period: p.period,
      limitType: p.type,
      previousAmount: p.previousAmount,
      previousMinutes: p.previousMinutes === null ? null : String(p.previousMinutes),
      amount: p.amount,
      minutes: p.minutes === null ? null : String(p.minutes),
    },
  });
}

export default {
  id: 'notifications',
  register(ctx) {
    const logger = createLogger('notifications');

    // Subscriptions are wired before router factories run (boot order), so these refs are
    // null at registration but set from the router factory before any real event arrives.
    let svcRef: NotificationsService | null = null;
    let mailDispatchRef: MailDispatchPort | null = null;
    let identityReaderRef: IdentityReader | null = null;
    let jobQueueRef: JobQueueAdapter | null = null;
    let realtimeRef: RealtimeTransport | null = null;
    let playEligibilityRef: PlayEligibilityPort | null = null;
    let geoCheckRef: GeoCheckCommands | null = null;
    let retentionDaysRef = DEFAULT_NOTIFICATIONS_RETENTION_DAYS;

    const dispatchMail = async (
      userId: string,
      template: MailTemplate,
      eventId: string,
    ): Promise<void> => {
      if (!mailDispatchRef) {
        return;
      }
      try {
        await mailDispatchRef.toUser({
          userId,
          template,
          idempotencyKey: `notifications-mail:${eventId}`,
        });
      } catch (err) {
        logger.error({ err, key: template.key }, 'notification mail enqueue failed');
      }
    };

    // Security alerts are explicitly opt-in and require a currently verified email.
    // Unlike the ordinary notification mail helper above, enqueue errors are surfaced to the
    // queue worker so they use its retry/dead-letter policy.
    const dispatchSecurityAlertMail = async (
      userId: string,
      template: MailTemplate,
      eventId: string,
    ): Promise<void> => {
      if (!mailDispatchRef || !identityReaderRef) {
        return;
      }
      if (!(await identityReaderRef.canReceiveLoginWithdrawalAlerts?.(userId))) {
        return;
      }
      await mailDispatchRef.toUser({
        userId,
        template,
        idempotencyKey: `security-alert-mail:${eventId}`,
      });
    };

    const publishNotification = (
      record: NonNullable<Awaited<ReturnType<NotificationsService['create']>>>,
    ) => {
      if (!realtimeRef) {
        return;
      }
      const dto = toNotificationDto(record);
      if (dto) {
        void Promise.resolve(realtimeRef.publish(notificationsChannel(record.userId), dto)).catch(
          (err: unknown) => logger.error({ err }, 'notification realtime publish failed'),
        );
      }
    };

    // The one place every `create()` call ends up on the realtime channel from - this
    // module's own dispatch jobs below, and an overlay's own `NotificationsService` instance
    // over a consumer-specific event `domainEventSchemas` has no entry for, since both share
    // this event bus and `create()` always emits this topic. Re-reads the row rather than
    // carrying it on the event: the event is `{ notificationId, userId }` only, the same shape
    // every other consumer of this topic (the audit log) already treats as the full payload.
    ctx.events.on('notifications.created', (payload) => {
      const parsed = domainEventSchemas['notifications.created'].safeParse(payload);
      if (!parsed.success || !svcRef) {
        return;
      }
      void svcRef
        .getById(parsed.data.notificationId)
        .then((record) => {
          if (record) {
            publishNotification(record);
          }
        })
        .catch((err: unknown) => logger.error({ err }, 'notification realtime lookup failed'));
    });

    for (const entry of notificationEventMap) {
      ctx.events.on(entry.event, (payload, envelope) => {
        if (!jobQueueRef || !envelope) {
          return;
        }
        const data = entry.parse(payload);
        if (data === null) {
          return;
        }
        jobQueueRef
          .enqueue(
            NOTIFICATIONS_DISPATCH_QUEUE,
            {
              event: entry.event,
              input: {
                ...entry.buildNotification(data),
                ...LEGACY_DISPATCH_TEXT,
                eventId: envelope.eventId,
              },
              email: entry.buildEmail(data, envelope.occurredAt),
              // An opted-in entry's email is preference-gated; every other entry always mails.
              securityAlert: entry.securityAlert,
            },
            {
              idempotencyKey: `notifications-dispatch:${envelope.eventId}`,
              attempts: 5,
              backoff: { type: 'exponential', delayMs: 1000 },
            },
          )
          .catch((err) =>
            logger.error({ err, event: entry.event }, 'notification dispatch enqueue failed'),
          );
      });
    }

    // The welcome mail is the first thing a consumer may put a sign-up bonus in, and it goes
    // out on verification - before the login gate has refused an RG-blocked account or the
    // geo gate a blocked country. Whatever cannot be confirmed reads as ineligible.
    const isEligibleForPromotions = async (userId: string, ip: string | null | undefined) => {
      if (!playEligibilityRef) {
        return false;
      }
      try {
        if (await playEligibilityRef.isRestricted(userId)) {
          return false;
        }
        if (!geoCheckRef) {
          return true;
        }
        const geoCheck = geoCheckRef.visitorGeoCheck ?? geoCheckRef.checkAccess;
        return (await geoCheck.call(geoCheckRef, ip ?? null)).allowed;
      } catch (err) {
        logger.error({ err, userId }, 'welcome mail promotion eligibility check failed');
        return false;
      }
    };

    ctx.events.on('identity.email.verified', async (payload) => {
      if (!mailDispatchRef) {
        return;
      }
      const parsed = domainEventSchemas['identity.email.verified'].safeParse(payload);
      if (!parsed.success) {
        return;
      }
      const { userId, ip } = parsed.data;
      const promotionsEligible = await isEligibleForPromotions(userId, ip);
      await mailDispatchRef
        .toUser({
          userId,
          template: { key: 'welcome', data: { promotionsEligible } },
          idempotencyKey: `welcome-mail:${userId}`,
        })
        .catch((err) => logger.error({ err }, 'welcome mail enqueue failed'));
    });

    ctx.events.on('identity.authentication.succeeded', async (payload, envelope) => {
      const parsed = domainEventSchemas['identity.authentication.succeeded'].safeParse(payload);
      if (!parsed.success || !jobQueueRef || !identityReaderRef) {
        return;
      }
      if (!envelope?.eventId) {
        logger.warn(
          { userId: parsed.data.userId },
          'security login alert enqueue skipped: missing event id',
        );
        return;
      }
      // Skip the job entirely for the normal opt-out case. Delivery checks the same
      // current state again, so a preference or email change between here and the
      // worker cannot result in a stale-address email.
      if (!(await identityReaderRef.canReceiveLoginWithdrawalAlerts?.(parsed.data.userId))) {
        return;
      }
      await jobQueueRef.enqueue(
        SECURITY_ALERT_DISPATCH_QUEUE,
        { userId: parsed.data.userId, eventId: envelope.eventId, occurredAt: envelope.occurredAt },
        {
          idempotencyKey: `security-login-alert:${envelope.eventId}`,
          attempts: 5,
          backoff: { type: 'exponential', delayMs: 1000 },
        },
      );
    });

    // Non-null `reason` marks an admin override (ADR-0037); player-initiated
    // limit changes always emit `reason: null`.
    ctx.events.on('rg.limit.set', (payload) => {
      const parsed = domainEventSchemas['rg.limit.set'].safeParse(payload);
      if (!parsed.success || !svcRef || parsed.data.reason === null) {
        return;
      }
      // In-app only: `RgService.setPlayerLimit` already sends the `rgLimitUpdated` mail on this write.
      svcRef
        .create(buildRgLimitAdminUpdatedNotification(parsed.data))
        .catch((err) => logger.error({ err }, 'rg.limit.set admin-override notification failed'));
    });

    ctx.events.on('chat.room.scheduled_for_deletion', (payload, envelope) => {
      const parsed = domainEventSchemas['chat.room.scheduled_for_deletion'].safeParse(payload);
      if (!parsed.success || !jobQueueRef) {
        return;
      }
      const p = parsed.data;
      if (!envelope?.eventId) {
        logger.warn({ roomId: p.roomId }, 'chat-room-deletion notify skipped: missing eventId');
        return;
      }
      const eventId = envelope.eventId;
      const jobQueue = jobQueueRef;
      for (const userId of p.memberIds.filter((id) => id !== p.previousOwnerId)) {
        jobQueue
          .enqueue(
            NOTIFICATIONS_DISPATCH_QUEUE,
            {
              event: 'chat.room.scheduled_for_deletion',
              input: {
                ...LEGACY_DISPATCH_TEXT,
                ...buildChatRoomScheduledForDeletionNotification({
                  userId,
                  roomId: p.roomId,
                  roomName: p.roomName,
                }),
              },
              // In-app only: `email` is nullish on NotificationDispatchJobSchema, so
              // omitting it is the current equivalent of the old `sendEmail: false`.
            },
            {
              idempotencyKey: `notifications-dispatch:${eventId}:${userId}`,
              attempts: 5,
              backoff: { type: 'exponential', delayMs: 1000 },
            },
          )
          .catch((err) =>
            logger.error({ err }, 'chat.room.scheduled_for_deletion dispatch enqueue failed'),
          );
      }
    });

    ctx.events.on('compliance.kyc.updated', (payload, envelope) => {
      const parsed = domainEventSchemas['compliance.kyc.updated'].safeParse(payload);
      if (!parsed.success || !jobQueueRef) {
        return;
      }
      const p = parsed.data;
      // Generic copy below assumes basic-tier document requirements; advanced-tier
      // resubmission has no tier-specific copy yet (see tag-evaluation.service.ts's
      // same guard).
      if (p.status !== 'resubmission_requested' || p.source !== 'manual' || p.tier !== 'basic') {
        return;
      }
      if (!envelope?.eventId) {
        logger.warn(
          { userId: p.userId },
          'kyc-resubmission-notify enqueue skipped: missing eventId',
        );
        return;
      }
      jobQueueRef
        .enqueue(
          KYC_RESUBMISSION_NOTIFY_QUEUE,
          { userId: p.userId, reason: p.reason, eventId: envelope.eventId },
          { idempotencyKey: `kyc-resubmission-notify:${envelope.eventId}` },
        )
        .catch((err) => logger.error({ err }, 'kyc-resubmission-notify enqueue failed'));
    });

    ctx.jobs.worker({
      queue: KYC_RESUBMISSION_NOTIFY_QUEUE,
      schema: KycResubmissionNotifyJobSchema,
      handler: async ({ payload }) => {
        if (!svcRef) {
          return;
        }
        const input = buildKycResubmissionNotification(payload);
        const record = await svcRef.create(input);
        if (!record) {
          return;
        }
        if (payload.eventId) {
          await dispatchMail(
            payload.userId,
            { key: 'kycResubmissionRequested', data: { reason: payload.reason } },
            payload.eventId,
          );
        }
      },
    });

    ctx.jobs.worker({
      queue: NOTIFICATIONS_DISPATCH_QUEUE,
      schema: NotificationDispatchJobSchema,
      handler: async ({ payload }) => {
        if (!svcRef) {
          return;
        }
        const record = await svcRef.createFromQueuedJob(payload.input);
        if (!record) {
          // A prior attempt may have already persisted the in-app notification. Continue so a
          // retried security alert can still be delivered through this job's retry policy.
          if (payload.securityAlert && payload.email && payload.input.eventId) {
            await dispatchSecurityAlertMail(
              payload.input.userId,
              payload.email,
              payload.input.eventId,
            );
          }
          return;
        }
        if (payload.email) {
          const mailKey = payload.input.eventId ?? record.id;
          await (payload.securityAlert
            ? dispatchSecurityAlertMail(record.userId, payload.email, mailKey)
            : dispatchMail(record.userId, payload.email, mailKey));
        }
      },
      onDeadLetter: (jobCtx, error) => {
        logger.error(
          { err: error, event: jobCtx.payload.event, jobId: jobCtx.id },
          'notification dispatch exhausted retries',
        );
      },
    });

    ctx.jobs.worker({
      queue: SECURITY_ALERT_DISPATCH_QUEUE,
      schema: SecurityAlertDispatchJobSchema,
      handler: async ({ payload }) => {
        await dispatchSecurityAlertMail(
          payload.userId,
          { key: 'securityLoginAlert', data: { occurredAt: payload.occurredAt } },
          payload.eventId,
        );
      },
      onDeadLetter: (jobCtx, error) => {
        logger.error(
          { err: error, userId: jobCtx.payload.userId, jobId: jobCtx.id },
          'security login alert delivery exhausted retries',
        );
      },
    });

    ctx.jobs.worker({
      queue: NOTIFICATIONS_RETENTION_PURGE_QUEUE,
      schema: z.object({}),
      handler: async () => {
        if (!svcRef) {
          return;
        }
        const { count } = await svcRef.purgeExpired(retentionDaysRef);
        logger.info({ count }, 'notification retention purge complete');
      },
    });

    ctx.routers.add('notifications', (c) => {
      const svc = new NotificationsService(c.get(DRIZZLE), c.get(EVENT_BUS));
      svcRef = svc;
      mailDispatchRef = c.has(MAIL_DISPATCH) ? c.get(MAIL_DISPATCH) : null;
      identityReaderRef = c.get(IDENTITY_READER);
      jobQueueRef = c.get(JOB_QUEUE);
      realtimeRef = c.get(REALTIME_TRANSPORT);
      playEligibilityRef = c.has(PLAY_ELIGIBILITY) ? c.get(PLAY_ELIGIBILITY) : null;
      geoCheckRef = c.has(GEO_CHECK_COMMANDS) ? c.get(GEO_CHECK_COMMANDS) : null;
      const platformConfig = c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined;
      retentionDaysRef =
        platformConfig?.notifications?.retention?.days ?? DEFAULT_NOTIFICATIONS_RETENTION_DAYS;
      const purgeCron =
        platformConfig?.notifications?.retention?.cron ?? DEFAULT_NOTIFICATIONS_RETENTION_CRON;
      // Off-peak, one hour after tag's daily-evaluation (0 2 * * *), so the in-process
      // driver doesn't run both sweeps at once in dev/test.
      void jobQueueRef.schedule(
        NOTIFICATIONS_RETENTION_PURGE_QUEUE,
        'notifications.retention-purge.daily',
        {},
        { cron: purgeCron },
      );
      return createNotificationsRouter({ notifications: svc, realtime: realtimeRef });
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
