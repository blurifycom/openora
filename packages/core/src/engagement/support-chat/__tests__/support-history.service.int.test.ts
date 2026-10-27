import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import {
  SupportHistoryProviderError,
  type SupportHistoryItem,
  type SupportHistoryReader,
} from '@openora/core/contracts';
import { createTestDb, seedPlayerWithUser, type TestDb } from '@openora/core/testing';
import { migrate as migrateAudit } from '@openora/core/audit/migrate';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeCache } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { supportChatCustomer } from '../schema/index.js';
import { SupportHistoryService } from '../service/support-history.service.js';

const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@openora/core/server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLogger: () => log,
}));

const TICKET: SupportHistoryItem = {
  kind: 'ticket',
  id: 'ticket-1',
  reference: '#1',
  subject: 'Withdrawal question',
  status: 'open',
  assignee: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  url: 'https://agent.example.test/ticket/1',
};

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateProfile, migrateAudit, migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(() => {
  log.warn.mockClear();
});

const service = (reader: Partial<SupportHistoryReader>) =>
  new SupportHistoryService({
    drizzle: db.drizzle,
    cache: makeCache(),
    reader: { listTickets: async () => [TICKET], listChats: async () => [], ...reader },
  });

async function linkedPlayer() {
  const { account, player } = await seedPlayerWithUser(db);
  await db.drizzle.db
    .insert(supportChatCustomer)
    .values({ playerId: player.id, providerCustomerId: `customer-${randomUUID()}` });
  return { userId: account.id };
}

const warned = () => log.warn.mock.calls.map(([fields]) => fields as unknown);

describe('SupportHistoryService logging (real PG)', () => {
  it('logs a provider error reason with the user and section only', async () => {
    const p = await linkedPlayer();
    const history = await service({
      listTickets: async () => {
        throw new SupportHistoryProviderError('rate_limited');
      },
    }).getHistory(p.userId, false);

    expect(history.tickets).toEqual({ state: 'unavailable', items: [], complete: false });
    expect(warned()).toEqual([{ userId: p.userId, section: 'ticket', reason: 'rate_limited' }]);
  });

  it('logs a reason outside the listed codes as unlisted, its text kept out of the log and the answer', async () => {
    const p = await linkedPlayer();
    const leak = `player jane.doe@example.test token sk_live_${randomUUID()}`;
    const history = await service({
      listTickets: async () => {
        // What a JavaScript adapter can pass past the reason type.
        throw Reflect.construct(SupportHistoryProviderError, [leak]);
      },
    }).getHistory(p.userId, false);

    expect(history.tickets).toEqual({ state: 'unavailable', items: [], complete: false });
    expect(warned()).toEqual([{ userId: p.userId, section: 'ticket', reason: 'unlisted reason' }]);
    expect(inspect([log.warn.mock.calls, history], { depth: null })).not.toMatch(
      /jane\.doe|sk_live_/,
    );
  });

  it('logs a raw adapter error as unexpected, its secret kept out of the log and the answer', async () => {
    const p = await linkedPlayer();
    const secret = `sk_live_${randomUUID()}`;
    const history = await service({
      listChats: async () => {
        throw Object.assign(new TypeError(`GET https://vendor.example/chats?key=${secret}`), {
          // A writable name can hold anything too.
          name: `jane.doe@example.test ${secret}`,
          config: { headers: { Authorization: `Bearer ${secret}` } },
        });
      },
    }).getHistory(p.userId, false);

    expect(history.chats).toEqual({ state: 'unavailable', items: [] });
    expect(warned()).toEqual([
      { userId: p.userId, section: 'chat', reason: 'unexpected adapter error' },
    ]);
    expect(inspect([log.warn.mock.calls, history], { depth: null })).not.toMatch(
      /jane\.doe|sk_live_/,
    );
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://agent.example.test/1',
    'https:../players/1',
    'https:evil.example',
  ])('answers a section unavailable for an item linking to %s', async (url) => {
    const p = await linkedPlayer();

    const history = await service({ listTickets: async () => [{ ...TICKET, url }] }).getHistory(
      p.userId,
      false,
    );

    expect(history.tickets).toEqual({ state: 'unavailable', items: [], complete: false });
    expect(warned()).toEqual([{ userId: p.userId, section: 'ticket', reason: 'malformed answer' }]);
  });

  it.each(['https://agent.example.test/ticket/1', 'HTTPS://agent.example.test'])(
    'accepts an absolute https link as given (%s)',
    async (url) => {
      const p = await linkedPlayer();

      const history = await service({ listTickets: async () => [{ ...TICKET, url }] }).getHistory(
        p.userId,
        false,
      );

      expect(history.tickets).toEqual({ state: 'ok', items: [{ ...TICKET, url }], complete: true });
    },
  );
});
