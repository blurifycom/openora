import { implement } from '@orpc/server';
import {
  RATE_LIMIT_KEYS,
  makeRateLimitKey,
  type RateLimiterAdapter,
  type RateLimitKey,
} from '@openora/core/contracts';
import { assertRateLimit, getUserId, mapErrors, type OssContext } from '@openora/core/server';
import { supportChatContract } from '../contract/index.js';
import {
  SupportChatLinkMissingError,
  SupportChatNotConfiguredError,
  SupportChatPlayerNotFoundError,
  SupportChatUnavailableError,
  type SupportChatService,
} from '../service/support-chat.service.js';

// Every call spends the operator's vendor quota.
const SESSION_RATE_LIMIT = { limit: 10, windowMs: 60_000, onUnavailable: 'allow' } as const;

/** `supportChat` is null when no provider is bound: the route then answers not configured. */
export function createSupportChatRouter(
  supportChat: SupportChatService | null,
  limiter: RateLimiterAdapter<RateLimitKey>,
) {
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
          if (!supportChat) {
            throw new SupportChatNotConfiguredError();
          }
          return supportChat.openSession(userId, context.clientMeta);
        },
      );
    }),
  });
}
