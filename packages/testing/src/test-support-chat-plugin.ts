import { randomUUID } from 'node:crypto';
import { type CoreTokenCatalog, type Plugin } from '@openora/core/server';
import {
  SUPPORT_CHAT_PROVIDER,
  SupportChatProviderError,
  type SupportChatProvider,
  type SupportCustomerContext,
} from '@openora/core/contracts';

export type TestSupportChatSync = { customerId: string; context: SupportCustomerContext };

type NextTokenAnswer =
  | { kind: 'fail'; reason: string }
  | { kind: 'malformed' }
  | { kind: 'customer'; customerId: string };

type SupportChatState = {
  tokenRequests: { customerId?: string }[];
  syncs: TestSupportChatSync[];
  nextTokenAnswer: NextTokenAnswer | null;
  syncDelayMs: number;
  heldSync: { customerId: string; reached: () => void; released: Promise<void> } | null;
};

// On the process, not the module: the app loads this file as a separate module instance from
// the test that steers it.
const STATE = Symbol.for('openora.testing.support-chat');
const holder = globalThis as typeof globalThis & { [STATE]?: SupportChatState };
const freshState = (): SupportChatState => ({
  tokenRequests: [],
  syncs: [],
  nextTokenAnswer: null,
  syncDelayMs: 0,
  heldSync: null,
});
const state = (): SupportChatState => (holder[STATE] ??= freshState());

/** Forget every recorded call and every pending instruction. */
export const resetSupportChat = () => {
  holder[STATE] = freshState();
};

/** The next `issueCustomerToken` throws a provider error carrying `reason`. */
export const failNextSupportChatToken = (reason: string) => {
  state().nextTokenAnswer = { kind: 'fail', reason };
};

/** The next `issueCustomerToken` answers a token without an access token. */
export const malformNextSupportChatToken = () => {
  state().nextTokenAnswer = { kind: 'malformed' };
};

/** The next `issueCustomerToken` answers a token for `customerId`, whatever was asked. */
export const answerNextSupportChatTokenWith = (customerId: string) => {
  state().nextTokenAnswer = { kind: 'customer', customerId };
};

/** Every `syncCustomer` waits this long before it lands. */
export const setSupportChatSyncDelay = (ms: number) => {
  state().syncDelayMs = ms;
};

/**
 * Holds the next `syncCustomer` call for `customerId` before it lands: `reached` resolves once
 * that call is held, and the write lands only after `release()`.
 */
export const holdNextSupportChatSync = (customerId: string) => {
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  state().heldSync = { customerId, reached, released };
  return { reached: reachedPromise, release };
};

/** Every token request and every landed sync, in order. */
export const readSupportChatCalls = () => ({
  tokenRequests: [...state().tokenRequests],
  syncs: [...state().syncs],
});

/**
 * Binds a fake support-chat vendor: a new customer per token request without `customerId`, a
 * token for the asked customer otherwise, and syncs recorded when they land. Steered by the
 * functions above. Opt-in only - pass it in `config.plugins`.
 */
export default {
  id: 'testing-support-chat',
  dependsOn: ['support-chat'],
  register(ctx) {
    ctx.provide(
      SUPPORT_CHAT_PROVIDER,
      () =>
        ({
          async issueCustomerToken(input) {
            const s = state();
            s.tokenRequests.push({ ...input });
            const next = s.nextTokenAnswer;
            s.nextTokenAnswer = null;
            if (next?.kind === 'fail') {
              throw new SupportChatProviderError(next.reason);
            }
            const customerId =
              next?.kind === 'customer'
                ? next.customerId
                : (input.customerId ?? `customer-${randomUUID()}`);
            return {
              customerId,
              accessToken: next?.kind === 'malformed' ? '' : `token-${randomUUID()}`,
              tokenType: 'Bearer',
              expiresInMs: 3_600_000,
            };
          },
          async syncCustomer(customerId, context) {
            const s = state();
            const held = s.heldSync?.customerId === customerId ? s.heldSync : null;
            if (held) {
              s.heldSync = null;
              held.reached();
              await held.released;
            }
            if (s.syncDelayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, s.syncDelayMs));
            }
            state().syncs.push({ customerId, context });
          },
        }) satisfies SupportChatProvider,
    );
  },
} satisfies Plugin<CoreTokenCatalog>;
