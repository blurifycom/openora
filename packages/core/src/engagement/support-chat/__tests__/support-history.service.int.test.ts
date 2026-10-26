import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { inspect } from 'node:util';
import {
  SupportHistoryProviderError,
  type SupportHistoryItem,
  type SupportHistoryReader,
} from '@openora/core/contracts';
import { createTestDb, seedPlayerWithUser, type TestDb } from '@openora/core/testing';
import { migrate as migrateAudit } from '@openora/core/audit/migrate';
import { AuditService } from '@openora/core/audit/server';
import { auditLog } from '@openora/core/audit/schema';
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
  return {
    userId: account.id,
    playerId: player.id,
    email: account.email,
    registeredAt: account.createdAt,
  };
}

/** Records one email change onto the player's current email; `after` extends the row's `after`. */
async function recordEmailChange(
  p: Awaited<ReturnType<typeof linkedPlayer>>,
  after: Record<string, unknown> = {},
) {
  const previous = `previous-${randomUUID()}@test.dev`;
  await new AuditService(db.drizzle, makeEventBus(), makeIdentityReader()).record({
    actorType: 'player',
    actorId: p.playerId,
    action: 'identity.email.changed',
    resourceType: 'player',
    resourceId: p.playerId,
    before: { email: previous },
    after: { email: p.email, ...after },
  });
  const [row] = await db.drizzle.db
    .select({ createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(eq(auditLog.resourceId, p.playerId));
  return { previous, writtenAt: row?.createdAt.toISOString() };
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

  it('trusts no window when the email trail is inconsistent: tickets unavailable, nobody asked, the user id alone logged', async () => {
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

  it('ends a window at the change time the row carries, not when the row was written', async () => {
    const p = await linkedPlayer();
    const changedAt = new Date(p.registeredAt.getTime() + 1_000).toISOString();
    const { previous } = await recordEmailChange(p, { changedAt });
    const listTickets = vi.fn(async () => []);

    await service({ listTickets }).getHistory(p.userId, false);

    expect(listTickets).toHaveBeenCalledWith({
      windows: [
        { email: previous, from: p.registeredAt.toISOString(), to: changedAt },
        { email: p.email, from: changedAt, to: null },
      ],
      includeResolved: false,
    });
  });

  it.each([{}, { changedAt: 'not a time' }])(
    'falls back to the write time for a row without a valid change time (%o)',
    async (after) => {
      const p = await linkedPlayer();
      const { previous, writtenAt } = await recordEmailChange(p, after);
      const listTickets = vi.fn(async () => []);

      await service({ listTickets }).getHistory(p.userId, false);

      expect(listTickets).toHaveBeenCalledWith({
        windows: [
          { email: previous, from: p.registeredAt.toISOString(), to: writtenAt },
          { email: p.email, from: writtenAt, to: null },
        ],
        includeResolved: false,
      });
    },
  );

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

    expect(history.tickets).toEqual({ state: 'unavailable', items: [] });
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

      expect(history.tickets).toEqual({ state: 'ok', items: [{ ...TICKET, url }] });
    },
  );
});
