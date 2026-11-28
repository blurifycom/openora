import { type CoreTokenCatalog, type Plugin } from '@openora/core/server';
import {
  SUPPORT_HISTORY_READER,
  SupportHistoryProviderError,
  type SupportHistoryFailureReason,
  type SupportHistoryItem,
  type SupportHistoryReader,
} from '@openora/core/contracts';

type Method = keyof SupportHistoryReader;
type TicketsInput = Parameters<SupportHistoryReader['listTickets']>[0];
type ChatsInput = Parameters<SupportHistoryReader['listChats']>[0];

type SupportHistoryState = {
  answers: Record<Method, SupportHistoryItem[]>;
  failures: Partial<Record<Method, SupportHistoryFailureReason | Error>>;
  malformed: Partial<Record<Method, SupportHistoryItem>>;
  calls: { listTickets: TicketsInput[]; listChats: ChatsInput[] };
};

const STATE = Symbol.for('openora.testing.support-history');
const holder = globalThis as typeof globalThis & { [STATE]?: SupportHistoryState };
const freshState = (): SupportHistoryState => ({
  answers: { listTickets: [], listChats: [] },
  failures: {},
  malformed: {},
  calls: { listTickets: [], listChats: [] },
});
const state = (): SupportHistoryState => (holder[STATE] ??= freshState());

export const resetSupportHistory = () => {
  holder[STATE] = freshState();
};

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

export const failSupportHistory = (method: Method, reason: SupportHistoryFailureReason | Error) => {
  state().failures[method] = reason;
};

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

export const malformSupportHistory = (method: Method) => {
  state().malformed[method] = OFFSET_TIMESTAMP_ITEM;
};

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
