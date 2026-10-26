import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import {
  SupportHistoryProviderError,
  type CacheAdapter,
  type SupportHistoryItem,
  type SupportHistoryReader,
} from '@openora/core/contracts';
import { createTestDb, seedPlayerWithUser, type TestDb } from '@openora/core/testing';
import { migrate as migrateAudit } from '@openora/core/audit/migrate';
import { AuditService } from '@openora/core/audit/server';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeCache, makeEventBus, makeIdentityReader } from '../../../testing/mock.js';
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

const service = (reader: Partial<SupportHistoryReader>, cache: CacheAdapter = makeCache()) =>
  new SupportHistoryService({
    drizzle: db.drizzle,
    cache,
    reader: { listTickets: async () => [TICKET], listChats: async () => [], ...reader },
  });

async function linkedPlayer() {
  const { account, player } = await seedPlayerWithUser(db);
  await db.drizzle.db
    .insert(supportChatCustomer)
    .values({ playerId: player.id, providerCustomerId: `customer-${randomUUID()}` });
  return { userId: account.id, playerId: player.id, email: account.email };
}

const warned = () => log.warn.mock.calls.map(([fields]) => fields as unknown);

describe('SupportHistoryService logging (real PG)', () => {
  it('logs a provider error reason with the user and section only', async () => {
    const p = await linkedPlayer();
    const history = await service({
      listTickets: async () => {
        throw new SupportHistoryProviderError('vendor answered 503');
      },
    }).getHistory(p.userId, false);

    expect(history.tickets).toEqual({ state: 'unavailable', items: [] });
    expect(warned()).toEqual([
      { userId: p.userId, section: 'ticket', reason: 'vendor answered 503' },
    ]);
  });

  it('reduces a raw adapter error to its class name and keeps its secret out of the log', async () => {
    const p = await linkedPlayer();
    const secret = `sk_live_${randomUUID()}`;
    const history = await service({
      listChats: async () => {
        throw Object.assign(new TypeError(`GET https://vendor.example/chats?key=${secret}`), {
          config: { headers: { Authorization: `Bearer ${secret}` } },
        });
      },
    }).getHistory(p.userId, false);

    expect(history.chats).toEqual({ state: 'unavailable', items: [] });
    expect(warned()).toEqual([
      { userId: p.userId, section: 'chat', reason: 'adapter threw TypeError' },
    ]);
    expect(inspect(log.warn.mock.calls, { depth: null })).not.toContain(secret);
  });

  it('answers tickets unavailable and warns with the user id alone when a gap in the email change trail leaves no window', async () => {
    const p = await linkedPlayer();
    await new AuditService(db.drizzle, makeEventBus(), makeIdentityReader()).record({
      actorType: 'player',
      actorId: p.playerId,
      action: 'identity.email.changed',
      resourceType: 'player',
      resourceId: p.playerId,
      before: { email: `lost-${randomUUID()}@test.dev` },
      after: { email: `not-current-${randomUUID()}@test.dev` },
    });
    const listTickets = vi.fn(async () => [TICKET]);

    const history = await service({ listTickets }).getHistory(p.userId, false);

    expect(history.tickets).toEqual({ state: 'unavailable', items: [] });
    expect(listTickets).not.toHaveBeenCalled();
    expect(warned()).toEqual([{ userId: p.userId }]);
    expect(inspect(log.warn.mock.calls, { depth: null })).not.toContain('@test.dev');
  });
});
