import { type CoreTokenCatalog, type Plugin } from '@openora/core/server';
import {
  SUPPORT_HISTORY_READER,
  SupportHistoryProviderError,
  type SupportHistoryItem,
  type SupportHistoryReader,
} from '@openora/core/contracts';

type Method = keyof SupportHistoryReader;
type TicketsInput = Parameters<SupportHistoryReader['listTickets']>[0];
type ChatsInput = Parameters<SupportHistoryReader['listChats']>[0];

type SupportHistoryState = {
  answers: Record<Method, SupportHistoryItem[]>;
  failures: Partial<Record<Method, string | Error>>;
  malformed: Partial<Record<Method, SupportHistoryItem>>;
  calls: { listTickets: TicketsInput[]; listChats: ChatsInput[] };
};

// On the process, not the module: the app loads this file as a separate module instance from
// the test that steers it.
const STATE = Symbol.for('openora.testing.support-history');
const holder = globalThis as typeof globalThis & { [STATE]?: SupportHistoryState };
const freshState = (): SupportHistoryState => ({
  answers: { listTickets: [], listChats: [] },
  failures: {},
  malformed: {},
  calls: { listTickets: [], listChats: [] },
});
const state = (): SupportHistoryState => (holder[STATE] ??= freshState());

/** Forget every recorded call and every instruction. */
export const resetSupportHistory = () => {
  holder[STATE] = freshState();
};

/** What `listTickets` and `listChats` answer from now on; an omitted one keeps its answer. */
export const answerSupportHistoryWith = (answers: {
  tickets?: SupportHistoryItem[];
  chats?: SupportHistoryItem[];
}) => {
  const s = state();
  s.answers = {
    listTickets: answers.tickets ?? s.answers.listTickets,
    listChats: answers.chats ?? s.answers.listChats,
  };
};

/**
 * `method` throws a provider error carrying `reason` from now on, or, given an `Error`, throws
 * that error as is - an adapter that let a raw client error escape.
 */
export const failSupportHistory = (method: Method, reason: string | Error) => {
  state().failures[method] = reason;
};

// Typed as an item, but its offset timestamp fails the schema, which takes only UTC `Z` times.
const OFFSET_TIMESTAMP_ITEM: SupportHistoryItem = {
  kind: 'ticket',
  id: 'offset-timestamp',
  reference: '#offset',
  subject: null,
  status: 'open',
  assignee: null,
  createdAt: '2026-01-01T01:00:00+01:00',
  updatedAt: '2026-01-01T01:00:00+01:00',
  url: 'https://agent.example.test/ticket/offset-timestamp',
};

/** `method` answers its items plus `item` (by default one with an offset timestamp) from now on. */
export const malformSupportHistory = (
  method: Method,
  item: SupportHistoryItem = OFFSET_TIMESTAMP_ITEM,
) => {
  state().malformed[method] = item;
};

/** Every call each method got, in order. */
export const readSupportHistoryCalls = () => ({
  listTickets: [...state().calls.listTickets],
  listChats: [...state().calls.listChats],
});

const answer = async (method: Method): Promise<SupportHistoryItem[]> => {
  const s = state();
  const failure = s.failures[method];
  if (failure !== undefined) {
    throw typeof failure === 'string' ? new SupportHistoryProviderError(failure) : failure;
  }
  const malformed = s.malformed[method];
  return malformed ? [...s.answers[method], malformed] : [...s.answers[method]];
};

/**
 * Binds a fake support-history vendor that records calls and answers the given items. Steered by
 * the functions above. Opt-in only - pass it in `config.plugins`.
 */
export default {
  id: 'testing-support-history',
  dependsOn: ['support-chat'],
  register(ctx) {
    ctx.provide(
      SUPPORT_HISTORY_READER,
      () =>
        ({
          async listTickets(input) {
            state().calls.listTickets.push(structuredClone(input));
            return answer('listTickets');
          },
          async listChats(input) {
            state().calls.listChats.push({ ...input });
            return answer('listChats');
          },
        }) satisfies SupportHistoryReader,
    );
  },
} satisfies Plugin<CoreTokenCatalog>;
