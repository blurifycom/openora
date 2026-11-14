import { randomUUID } from 'node:crypto';
import { type CoreTokenCatalog, type Plugin } from '@openora/core/server';
import {
  SUPPORT_CHAT_PROVIDER,
  SupportChatProviderError,
  type SupportChatCustomerToken,
  type SupportChatProvider,
  type SupportCustomerContext,
  type SupportHistoryFailureReason,
  type SupportTicketCreated,
  type SupportTicketRequest,
} from '@openora/core/contracts';

export type TestSupportChatSync = { customerId: string; context: SupportCustomerContext };
export type TestSupportTicket = SupportTicketRequest & { ticketId: string };

type NextTokenAnswer =
  | { kind: 'fail'; reason: SupportHistoryFailureReason }
  | { kind: 'throw'; error: Error }
  | { kind: 'malformed' }
  | { kind: 'raw'; answer: unknown }
  | { kind: 'customer'; customerId: string };

type SupportChatState = {
  tokenRequests: { customerId?: string }[];
  tickets: TestSupportTicket[];
  nextTicketFailure: SupportHistoryFailureReason | Error | null;
  nextTicketAnswer: { raw: unknown } | null;
  syncs: TestSupportChatSync[];
  nextTokenAnswer: NextTokenAnswer | null;
  syncDelayMs: number;
  failSyncs: boolean | Error;
  syncAttempts: string[];
  heldSync: { customerId: string; reached: () => void; released: Promise<void> } | null;
  syncHook: ((customerId: string) => Promise<void>) | null;
};

// On the process, not the module: the app loads this file as a separate module instance from
// the test that steers it.
const STATE = Symbol.for('openora.testing.support-chat');
const holder = globalThis as typeof globalThis & { [STATE]?: SupportChatState };
const freshState = (): SupportChatState => ({
  tokenRequests: [],
  tickets: [],
  nextTicketFailure: null,
  nextTicketAnswer: null,
  syncs: [],
  nextTokenAnswer: null,
  syncDelayMs: 0,
  failSyncs: false,
  syncAttempts: [],
  heldSync: null,
  syncHook: null,
});
const state = (): SupportChatState => (holder[STATE] ??= freshState());

/** Forget every recorded call and every pending instruction. */
export const resetSupportChat = () => {
  holder[STATE] = freshState();
};

/**
 * The next `issueCustomerToken` throws a provider error carrying `reason`, or, given an
 * `Error`, throws that error as is - an adapter that let a raw client error escape.
 */
export const failNextSupportChatToken = (reason: SupportHistoryFailureReason | Error) => {
  state().nextTokenAnswer =
    typeof reason === 'string' ? { kind: 'fail', reason } : { kind: 'throw', error: reason };
};

/**
 * The next `createTicket` throws a provider error carrying `reason`, or, given an `Error`,
 * throws that error as is, and records no ticket.
 */
export const failNextSupportTicket = (reason: SupportHistoryFailureReason | Error) => {
  state().nextTicketFailure = reason;
};

/** The next `createTicket` records the ticket, then answers `answer` as is, whatever its shape. */
export const answerNextSupportTicketRaw = (answer: unknown) => {
  state().nextTicketAnswer = { raw: answer };
};

/** The next `issueCustomerToken` answers a token without an access token. */
export const malformNextSupportChatToken = () => {
  state().nextTokenAnswer = { kind: 'malformed' };
};

/** The next `issueCustomerToken` answers `answer` as is, whatever its shape. */
export const answerNextSupportChatTokenRaw = (answer: unknown) => {
  state().nextTokenAnswer = { kind: 'raw', answer };
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
 * While on, every `syncCustomer` rejects with a provider error instead of landing. Given an
 * `Error`, it throws that error as is and before returning a promise - an adapter that let a raw
 * client error escape from code that is not async.
 */
export const failSupportChatSyncs = (on: boolean | Error) => {
  state().failSyncs = on;
};

/** Runs inside every `syncCustomer` before it lands, until set back to null. */
export const setSupportChatSyncHook = (hook: ((customerId: string) => Promise<void>) | null) => {
  state().syncHook = hook;
};

/** How many `syncCustomer` calls `customerId` has had so far, landed or failed. */
export const supportChatSyncAttempts = (customerId: string) =>
  state().syncAttempts.filter((attempted) => attempted === customerId).length;

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

/** Every token request, every landed sync and every created ticket, in order. */
export const readSupportChatCalls = () => ({
  tokenRequests: [...state().tokenRequests],
  tickets: [...state().tickets],
  syncs: [...state().syncs],
});

/**
 * Binds a fake support-chat vendor: a new customer per token request without `customerId`, a
 * token for the asked customer otherwise, and syncs and tickets recorded when they land. Steered by the
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
            if (next?.kind === 'throw') {
              throw next.error;
            }
            if (next?.kind === 'raw') {
              return next.answer as SupportChatCustomerToken;
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
          syncCustomer(customerId, context) {
            const s = state();
            s.syncAttempts.push(customerId);
            if (s.failSyncs instanceof Error) {
              throw s.failSyncs;
            }
            return (async () => {
              if (s.failSyncs) {
                throw new SupportChatProviderError('unavailable');
              }
              const held = s.heldSync?.customerId === customerId ? s.heldSync : null;
              if (held) {
                s.heldSync = null;
                held.reached();
                await held.released;
              }
              await s.syncHook?.(customerId);
              if (s.syncDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, s.syncDelayMs));
              }
              state().syncs.push({ customerId, context });
            })();
          },
          async createTicket(input) {
            const s = state();
            const failure = s.nextTicketFailure;
            s.nextTicketFailure = null;
            if (typeof failure === 'string') {
              throw new SupportChatProviderError(failure);
            }
            if (failure) {
              throw failure;
            }
            const ticketId = `ticket-${randomUUID()}`;
            s.tickets.push({ ...structuredClone(input), ticketId });
            const raw = s.nextTicketAnswer;
            s.nextTicketAnswer = null;
            return raw ? (raw.raw as SupportTicketCreated) : { ticketId };
          },
        }) satisfies SupportChatProvider,
    );
  },
} satisfies Plugin<CoreTokenCatalog>;
