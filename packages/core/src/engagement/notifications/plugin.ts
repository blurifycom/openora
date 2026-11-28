import * as z from 'zod';
import {
  AUDIT_WRITER,
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
  type AuditWritePort,
  type GeoCheckCommands,
  type IdentityReader,
  type JobQueueAdapter,
  type KycTier,
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
import {
  isStaffKycResubmissionRequest,
  KycResubmissionNotifyJobSchema,
} from './shared/kyc-resubmission-request.js';

const KYC_RESUBMISSION_NOTIFY_QUEUE = queue('kyc-resubmission-notify');
const NOTIFICATIONS_RETENTION_PURGE_QUEUE = queue('notifications-retention-purge');
const NOTIFICATIONS_DISPATCH_QUEUE = queue('notifications-dispatch');
const SECURITY_ALERT_DISPATCH_QUEUE = queue('security-alert-dispatch');

const RETRY = { attempts: 5, backoff: { type: 'exponential', delayMs: 1000 } } as const;

const DEFAULT_NOTIFICATIONS_RETENTION_DAYS = 30;
const DEFAULT_NOTIFICATIONS_RETENTION_CRON = '0 3 * * *';

const NotificationDispatchJobSchema = z.object({
  event: z.string(),
  input: QueuedNotificationInputSchema,
  email: MailTemplateSchema.nullish(),
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
  securityAlert: boolean;
};

export function compactData(
  fields: Record<string, string | null | undefined>,
): Record<string, string> | null {
  const entries = Object.entries(fields).filter(
    (entry): entry is [string, string] => entry[1] !== null && entry[1] !== undefined,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

type ParamKeys<T extends NotificationType> = (typeof NOTIFICATION_PARAM_KEYS)[T];

type NotificationParamsOf<T extends NotificationType> = [
  ParamKeys<T>['required'][number] | ParamKeys<T>['optional'][number],
] extends [never]
  ? Record<string, never>
  : Record<ParamKeys<T>['required'][number], string> &
      Partial<Record<ParamKeys<T>['optional'][number], string | null>>;

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
      email: (p) =>
        p.source === 'gift' || p.source === 'rain' || p.source === 'donation'
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
        dailyBonusPercent: p.dailyBonusPercent,
        weeklyBonusPercent: p.weeklyBonusPercent,
        monthlyBonusPercent: p.monthlyBonusPercent,
        periodicBasis: p.periodicBasis,
      },
      data: { tierId: p.tierId },
    }),
  ),

  mapEvent('promo.streak.milestone.reached', (p) =>
    notification({
      userId: p.userId,
      type: 'promo.streak.milestone.reached',
      params: { day: String(p.day), amount: p.amount ?? null, currency: p.currency ?? null },
      data: compactData({ day: String(p.day), amount: p.amount, currency: p.currency }),
    }),
  ),

  mapEvent('promo.rakeback.claimable', (p) =>
    notification({
      userId: p.userId,
      type: 'rakeback.claimable',
      params: { amount: p.amount, currency: p.currency },
    }),
  ),

  mapEvent('promo.rank.reward.claimable', (p) =>
    notification({
      userId: p.userId,
      type: 'rank.reward.claimable',
      params: { kind: p.kind, amount: p.amount, currency: p.currency },
      data: { rewardId: p.rewardId },
    }),
  ),

  mapEvent('chat.user.mentioned', (p) =>
    notification({
      userId: p.mentionedUserId,
      type: 'chat.mention',
      params: { byUsername: p.byUsername },
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
      data: { accepterId: p.accepterId },
    }),
  ),

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
  tier: KycTier;
  eventId?: string;
}): CreateNotificationInput {
  return {
    ...notification({
      userId: payload.userId,
      type: 'kyc.resubmission_requested',
      params: {
        reason: payload.tier === 'advanced' ? null : payload.reason || null,
        tier: payload.tier,
      },
    }),
    eventId: payload.eventId ?? null,
  };
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
      currency: p.currency,
      previousCurrency: p.previousCurrency,
    },
  });
}

const logger = createLogger('notifications');

export default {
  id: 'notifications',
  controlPorts: [
    {
      port: AUDIT_WRITER,
      without: 'a KYC resubmission notice that never reaches the mail queue goes unaudited',
      boundBy: 'audit',
    },
    {
      port: GEO_CHECK_COMMANDS,
      without: 'welcome mails offer promotions without the country check',
      boundBy: 'compliance',
    },
  ],
  register(ctx) {
    let svcRef: NotificationsService | null = null;
    let mailDispatchRef: MailDispatchPort | null = null;
    let identityReaderRef: IdentityReader | null = null;
    let jobQueueRef: JobQueueAdapter | null = null;
    let realtimeRef: RealtimeTransport | null = null;
    let playEligibilityRef: PlayEligibilityPort | null = null;
    let geoCheckRef: GeoCheckCommands | null = null;
    let auditRef: AuditWritePort | null = null;
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

    const requireService = (): NotificationsService => {
      if (!svcRef) {
        throw new Error('notifications service not constructed');
      }
      return svcRef;
    };
    const requireJobQueue = (): JobQueueAdapter => {
      if (!jobQueueRef) {
        throw new Error('notifications job queue not bound yet');
      }
      return jobQueueRef;
    };

    ctx.events.on('notifications.created', async (payload) => {
      const parsed = domainEventSchemas['notifications.created'].safeParse(payload);
      if (!parsed.success) {
        return;
      }
      const record = await requireService().getById(parsed.data.notificationId);
      if (record) {
        publishNotification(record);
      }
    });

    for (const entry of notificationEventMap) {
      ctx.events.on(entry.event, async (payload, envelope) => {
        if (!envelope) {
          return;
        }
        const data = entry.parse(payload);
        if (data === null) {
          return;
        }
        await requireJobQueue().enqueue(
          NOTIFICATIONS_DISPATCH_QUEUE,
          {
            event: entry.event,
            input: {
              ...entry.buildNotification(data),
              ...LEGACY_DISPATCH_TEXT,
              eventId: envelope.eventId,
            },
            email: entry.buildEmail(data, envelope.occurredAt),
            securityAlert: entry.securityAlert,
          },
          {
            idempotencyKey: `notifications-dispatch:${envelope.eventId}`,
            ...RETRY,
          },
        );
      });
    }

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
      requireService();
      if (!mailDispatchRef) {
        return;
      }
      const parsed = domainEventSchemas['identity.email.verified'].safeParse(payload);
      if (!parsed.success) {
        return;
      }
      const { userId, ip } = parsed.data;
      const promotionsEligible = await isEligibleForPromotions(userId, ip);
      await mailDispatchRef.toUser({
        userId,
        template: { key: 'welcome', data: { promotionsEligible } },
        idempotencyKey: `welcome-mail:${userId}`,
      });
    });

    ctx.events.on('identity.authentication.succeeded', async (payload, envelope) => {
      const parsed = domainEventSchemas['identity.authentication.succeeded'].safeParse(payload);
      if (!parsed.success) {
        return;
      }
      const jobQueue = requireJobQueue();
      if (!identityReaderRef) {
        return;
      }
      if (!envelope?.eventId) {
        logger.warn(
          { userId: parsed.data.userId },
          'security login alert enqueue skipped: missing event id',
        );
        return;
      }
      if (!(await identityReaderRef.canReceiveLoginWithdrawalAlerts?.(parsed.data.userId))) {
        return;
      }
      await jobQueue.enqueue(
        SECURITY_ALERT_DISPATCH_QUEUE,
        { userId: parsed.data.userId, eventId: envelope.eventId, occurredAt: envelope.occurredAt },
        {
          idempotencyKey: `security-login-alert:${envelope.eventId}`,
          ...RETRY,
        },
      );
    });

    ctx.events.on('rg.limit.set', async (payload, envelope) => {
      const parsed = domainEventSchemas['rg.limit.set'].safeParse(payload);
      if (!parsed.success || parsed.data.reason === null) {
        return;
      }
      await requireService().create({
        ...buildRgLimitAdminUpdatedNotification(parsed.data),
        ...(envelope ? { eventId: envelope.eventId } : {}),
      });
    });

    ctx.events.on('chat.room.scheduled_for_deletion', async (payload, envelope) => {
      const parsed = domainEventSchemas['chat.room.scheduled_for_deletion'].safeParse(payload);
      if (!parsed.success) {
        return;
      }
      const p = parsed.data;
      if (!envelope?.eventId) {
        logger.warn({ roomId: p.roomId }, 'chat-room-deletion notify skipped: missing eventId');
        return;
      }
      const eventId = envelope.eventId;
      const jobQueue = requireJobQueue();
      for (const userId of p.memberIds.filter((id) => id !== p.previousOwnerId)) {
        await jobQueue.enqueue(
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
          },
          {
            idempotencyKey: `notifications-dispatch:${eventId}:${userId}`,
            ...RETRY,
          },
        );
      }
    });

    ctx.events.on('compliance.kyc.updated', async (payload, envelope) => {
      const parsed = domainEventSchemas['compliance.kyc.updated'].safeParse(payload);
      if (!parsed.success) {
        return;
      }
      const p = parsed.data;
      if (!isStaffKycResubmissionRequest(p)) {
        return;
      }
      if (!envelope?.eventId) {
        logger.warn(
          { userId: p.userId },
          'kyc-resubmission-notify enqueue skipped: missing eventId',
        );
        return;
      }
      await requireJobQueue().enqueue(
        KYC_RESUBMISSION_NOTIFY_QUEUE,
        {
          userId: p.userId,
          reason: p.tier === 'advanced' ? null : p.reason,
          tier: p.tier,
          eventId: envelope.eventId,
        },
        {
          idempotencyKey: `kyc-resubmission-notify:${envelope.eventId}`,
          ...RETRY,
        },
      );
    });

    ctx.jobs.worker({
      queue: KYC_RESUBMISSION_NOTIFY_QUEUE,
      schema: KycResubmissionNotifyJobSchema,
      handler: async ({ payload }) => {
        if (!svcRef) {
          return;
        }
        await svcRef.create(buildKycResubmissionNotification(payload));
        if (!payload.eventId || !mailDispatchRef) {
          return;
        }
        await mailDispatchRef.toUser({
          userId: payload.userId,
          template: {
            key: 'kycResubmissionRequested',
            data: {
              reason: payload.tier === 'advanced' ? null : payload.reason,
              tier: payload.tier,
            },
          },
          idempotencyKey: `notifications-mail:${payload.eventId}`,
        });
      },
      onDeadLetter: async (jobCtx, error) => {
        logger.error(
          { err: error, userId: jobCtx.payload.userId, jobId: jobCtx.id },
          'kyc resubmission notice exhausted retries',
        );
        await auditRef
          ?.record({
            actorType: 'system',
            action: 'mail.regulatory_delivery.failed',
            resourceType: 'email',
            resourceId: jobCtx.payload.userId,
            after: {
              templateKey: 'kycResubmissionRequested',
              reason: 'enqueue_exhausted',
              attempt: jobCtx.attempt,
            },
          })
          .catch((err: unknown) =>
            logger.error({ err }, 'kyc resubmission notice audit write failed'),
          );
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

    ctx.routers.add('notifications', (c, options) => {
      const svc = new NotificationsService(c.get(DRIZZLE), c.get(EVENT_BUS));
      svcRef = svc;
      mailDispatchRef = c.has(MAIL_DISPATCH) ? c.get(MAIL_DISPATCH) : null;
      identityReaderRef = c.get(IDENTITY_READER);
      jobQueueRef = c.get(JOB_QUEUE);
      realtimeRef = c.get(REALTIME_TRANSPORT);
      playEligibilityRef = c.has(PLAY_ELIGIBILITY) ? c.get(PLAY_ELIGIBILITY) : null;
      geoCheckRef = c.has(GEO_CHECK_COMMANDS) ? c.get(GEO_CHECK_COMMANDS) : null;
      auditRef = c.has(AUDIT_WRITER) ? c.get(AUDIT_WRITER) : null;
      const platformConfig = c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined;
      retentionDaysRef =
        platformConfig?.notifications?.retention?.days ?? DEFAULT_NOTIFICATIONS_RETENTION_DAYS;
      const purgeCron =
        platformConfig?.notifications?.retention?.cron ?? DEFAULT_NOTIFICATIONS_RETENTION_CRON;
      if (options?.mounted !== false) {
        void jobQueueRef
          .schedule(
            NOTIFICATIONS_RETENTION_PURGE_QUEUE,
            'notifications.retention-purge.daily',
            {},
            { cron: purgeCron },
          )
          .catch((err: unknown) =>
            logger.error({ err }, 'notifications retention-purge schedule failed'),
          );
      }
      return createNotificationsRouter({ notifications: svc, realtime: realtimeRef });
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
