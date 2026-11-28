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

export const resetSupportChat = () => {
  holder[STATE] = freshState();
};

export const failNextSupportChatToken = (reason: SupportHistoryFailureReason | Error) => {
  state().nextTokenAnswer =
    typeof reason === 'string' ? { kind: 'fail', reason } : { kind: 'throw', error: reason };
};

export const failNextSupportTicket = (reason: SupportHistoryFailureReason | Error) => {
  state().nextTicketFailure = reason;
};

export const answerNextSupportTicketRaw = (answer: unknown) => {
  state().nextTicketAnswer = { raw: answer };
};

export const malformNextSupportChatToken = () => {
  state().nextTokenAnswer = { kind: 'malformed' };
};

export const answerNextSupportChatTokenRaw = (answer: unknown) => {
  state().nextTokenAnswer = { kind: 'raw', answer };
};

export const answerNextSupportChatTokenWith = (customerId: string) => {
  state().nextTokenAnswer = { kind: 'customer', customerId };
};

export const setSupportChatSyncDelay = (ms: number) => {
  state().syncDelayMs = ms;
};

export const failSupportChatSyncs = (on: boolean | Error) => {
  state().failSyncs = on;
};

export const setSupportChatSyncHook = (hook: ((customerId: string) => Promise<void>) | null) => {
  state().syncHook = hook;
};

export const supportChatSyncAttempts = (customerId: string) =>
  state().syncAttempts.filter((attempted) => attempted === customerId).length;

export const holdNextSupportChatSync = (customerId: string) => {
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  state().heldSync = { customerId, reached, released };
  return { reached: reachedPromise, release };
};

export const readSupportChatCalls = () => ({
  tokenRequests: [...state().tokenRequests],
  tickets: [...state().tickets],
  syncs: [...state().syncs],
});

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
