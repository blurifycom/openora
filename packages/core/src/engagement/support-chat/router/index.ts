import { implement } from '@orpc/server';
import {
  RATE_LIMIT_KEYS,
  makeRateLimitKey,
  type RateLimiterAdapter,
  type RateLimitKey,
} from '@openora/core/contracts';
import {
  assertRateLimit,
  getUserId,
  mapErrors,
  type AdminGuard,
  type OssContext,
} from '@openora/core/server';
import { supportChatContract } from '../contract/index.js';
import {
  SupportChatLinkMissingError,
  SupportChatNotConfiguredError,
  SupportChatPlayerNotFoundError,
  SupportChatUnavailableError,
  SupportTicketEmailNotVerifiedError,
  type SupportChatService,
} from '../service/support-chat.service.js';
import {
  SupportHistoryNotConfiguredError,
  type SupportHistoryService,
} from '../service/support-history.service.js';

// Every call spends the operator's vendor quota.
const SESSION_RATE_LIMIT = { limit: 10, windowMs: 60_000, onUnavailable: 'allow' } as const;
// Every ticket lands in the operator's support queue; a double submit counts twice.
const TICKET_RATE_LIMIT = { limit: 5, windowMs: 10 * 60_000, onUnavailable: 'allow' } as const;
// Per admin, cache hits included: staff clicking around must not burn the vendor's API quota.
const HISTORY_RATE_LIMIT = { limit: 30, windowMs: 60_000, onUnavailable: 'allow' } as const;

/** A service is null when its port is not bound: its route then answers not configured. */
export function createSupportChatRouter({
  session,
  history,
  limiter,
  adminGuard,
}: {
  session: SupportChatService | null;
  history: SupportHistoryService | null;
  limiter: RateLimiterAdapter<RateLimitKey>;
  adminGuard: AdminGuard;
}) {
  const os = implement(supportChatContract).$context<OssContext>();

  return os.router({
    session: os.session.handler(async ({ context }) => {
      const userId = getUserId(context);
      await assertRateLimit(
        limiter,
        makeRateLimitKey(RATE_LIMIT_KEYS.SUPPORT_CHAT_SESSION, userId),
        SESSION_RATE_LIMIT,
      );
      return mapErrors(
        {
          NOT_FOUND: SupportChatPlayerNotFoundError,
          SERVICE_UNAVAILABLE: [SupportChatNotConfiguredError, SupportChatUnavailableError],
          INTERNAL_SERVER_ERROR: SupportChatLinkMissingError,
        },
        async () => {
          if (!session) {
            throw new SupportChatNotConfiguredError();
          }
          return session.openSession(userId, context.clientMeta);
        },
      );
    }),

    createTicket: os.createTicket.handler(async ({ input, context }) => {
      const userId = getUserId(context);
      await assertRateLimit(
        limiter,
        makeRateLimitKey(RATE_LIMIT_KEYS.SUPPORT_TICKET_CREATE, userId),
        TICKET_RATE_LIMIT,
      );
      return mapErrors(
        {
          NOT_FOUND: SupportChatPlayerNotFoundError,
          FORBIDDEN: SupportTicketEmailNotVerifiedError,
          SERVICE_UNAVAILABLE: [SupportChatNotConfiguredError, SupportChatUnavailableError],
        },
        async () => {
          if (!session) {
            throw new SupportChatNotConfiguredError();
          }
          await session.createTicket(userId, input.message, context.clientMeta);
          return { success: true as const };
        },
      );
    }),

    playerHistory: os.playerHistory.handler(async ({ input, context }) => {
      const { userId: adminId } = await adminGuard.assert(context, 'support-chat', 'view');
      await assertRateLimit(
        limiter,
        makeRateLimitKey(RATE_LIMIT_KEYS.SUPPORT_CHAT_HISTORY, adminId),
        HISTORY_RATE_LIMIT,
      );
      return mapErrors(
        {
          NOT_FOUND: SupportChatPlayerNotFoundError,
          SERVICE_UNAVAILABLE: SupportHistoryNotConfiguredError,
        },
        async () => {
          if (!history) {
            throw new SupportHistoryNotConfiguredError();
          }
          return history.getHistory(input.userId, input.includeResolved ?? false);
        },
      );
    }),
  });
}
