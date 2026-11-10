import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import {
  SupportChatProviderError,
  SupportHistoryProviderError,
  type AuditWritePort,
  type RgExclusionReader,
  type SupportChatProvider,
  type WalletReader,
} from '@openora/core/contracts';
import { eq } from 'drizzle-orm';
import { createTestDb, seedPlayerWithUser, type TestDb } from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { migrate as migrateAudit } from '@openora/core/audit/migrate';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate as migrateGamification } from '@openora/core/promo/migrate/gamification';
import {
  NO_CLIENT_META,
  makeAuditWriter,
  makeEventBus,
  makeIdentityReader,
  mock,
} from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { supportChatCustomer } from '../schema/index.js';
import {
  SupportChatService,
  SupportChatSyncFailedError,
  SupportChatUnavailableError,
  SupportContextNotSettledError,
} from '../service/support-chat.service.js';

const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@openora/core/server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLogger: () => log,
}));

const EMAIL = 'jane.doe@example.test';
const LEAK = /jane\.doe|sk_live_/;

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([
    migrateIdentity,
    migrateProfile,
    migrateAudit,
    migrateGamification,
    migrate,
  ]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(() => {
  for (const fn of Object.values(log)) {
    fn.mockClear();
  }
});

async function linkedPlayer() {
  const { account, player } = await seedPlayerWithUser(db);
  await db.drizzle.db
    .insert(supportChatCustomer)
    .values({ playerId: player.id, providerCustomerId: `customer-${randomUUID()}` });
  return { userId: account.id, playerId: player.id };
}

const service = (
  playerId: string,
  provider: Partial<SupportChatProvider>,
  audit: AuditWritePort = makeAuditWriter(),
) =>
  new SupportChatService({
    drizzle: db.drizzle,
    audit,
    events: makeEventBus(),
    identityReader: {
      ...makeIdentityReader(),
      getPlayerIdByUserId: vi.fn().mockResolvedValue(playerId),
    },
    walletReader: mock<WalletReader>({ getBalances: async () => ({ activeCurrency: 'EUR' }) }),
    rgExclusionReader: mock<RgExclusionReader>({
      getExclusionState: async () => ({ isSelfExcluded: false, isCoolingOff: false }),
    }),
    accountManagerReader: null,
    provider: {
      issueCustomerToken: async () => {
        throw new Error('token path not under test');
      },
      syncCustomer: async () => undefined,
      ...provider,
    },
    scheduleSync: async () => undefined,
  });

const secret = () => `sk_live_${randomUUID()}`;
const warned = () => log.warn.mock.calls.map(([fields]) => fields as unknown);
const logged = () => Object.values(log).map((fn) => fn.mock.calls);

// What a JavaScript adapter can pass past the reason type: an email and a token in the reason
// and in the writable name.
const leakingProviderError = () => {
  const leak = `player ${EMAIL} token ${secret()}`;
  return Object.assign(Reflect.construct(SupportChatProviderError, [leak]) as Error, {
    name: leak,
  });
};

const rawClientError = () => {
  const key = secret();
  return Object.assign(new TypeError(`POST https://vendor.example/customers?key=${key}`), {
    name: `${EMAIL} ${key}`,
    config: { headers: { Authorization: `Bearer ${key}` } },
  });
};

const listedWithCause = () =>
  new SupportChatProviderError('timeout', {
    cause: Object.assign(new Error(`GET https://vendor.example?key=${secret()} for ${EMAIL}`), {
      name: `${EMAIL} ${secret()}`,
    }),
  });

async function refusedToken(thrown: () => unknown) {
  const p = await linkedPlayer();
  const error = await service(p.playerId, {
    issueCustomerToken: async () => {
      throw thrown();
    },
  })
    .openSession(p.userId, NO_CLIENT_META)
    .catch((err: unknown) => err);
  return { ...p, error };
}

async function failedSync(syncCustomer: SupportChatProvider['syncCustomer']) {
  const p = await linkedPlayer();
  const error = await service(p.playerId, { syncCustomer })
    .syncCustomer(p.userId)
    .catch((err: unknown) => err);
  return { ...p, error };
}

describe('SupportChatService token path logging (real PG)', () => {
  it.each([
    ['a provider error with an unlisted reason and name', 'unlisted reason', leakingProviderError],
    ['a raw client error', 'unexpected adapter error', rawClientError],
    ['a listed code whose cause holds vendor detail', 'timeout', listedWithCause],
    ['a listed code', 'rate_limited', () => new SupportChatProviderError('rate_limited')],
  ])('logs %s as `%s` only and answers unavailable', async (_case, reason, thrown) => {
    const { playerId, error } = await refusedToken(thrown);

    expect(error).toBeInstanceOf(SupportChatUnavailableError);
    expect(warned()).toEqual([{ playerId, reason }]);
    expect(inspect([logged(), error], { depth: null })).not.toMatch(LEAK);
  });

  it.each<[string, unknown]>([
    ['Timeout', 'Timeout'],
    ['timeout with a trailing space', 'timeout '],
    ['an empty string', ''],
    ['a number', 42],
    ['undefined', undefined],
    ['an object', { toString: () => 'timeout' }],
  ])('logs a provider error whose reason is %s as unlisted', async (_case, reason) => {
    const { playerId, error } = await refusedToken(() =>
      Reflect.construct(SupportChatProviderError, [reason]),
    );

    expect(error).toBeInstanceOf(SupportChatUnavailableError);
    expect(warned()).toEqual([{ playerId, reason: 'unlisted reason' }]);
  });

  it('keeps the listed code of a support-history provider error', async () => {
    const { playerId } = await refusedToken(() => new SupportHistoryProviderError('not_found'));

    expect(warned()).toEqual([{ playerId, reason: 'not_found' }]);
  });

  it.each<[string, () => unknown]>([
    ['a string', () => `${EMAIL} ${secret()}`],
    ['a plain object', () => ({ message: secret(), reason: 'timeout' })],
    ['null', () => null],
    [
      'an error named like a provider error',
      () => Object.assign(new Error('x'), { name: 'SupportChatProviderError', reason: 'timeout' }),
    ],
  ])('logs a thrown %s as unexpected', async (_case, thrown) => {
    const { playerId, error } = await refusedToken(thrown);

    expect(error).toBeInstanceOf(SupportChatUnavailableError);
    expect(warned()).toEqual([{ playerId, reason: 'unexpected adapter error' }]);
    expect(inspect([logged(), error], { depth: null })).not.toMatch(LEAK);
  });
});

describe('SupportChatService token answer (real PG)', () => {
  it('refuses a token answer whose field getter throws as malformed, its secret kept out', async () => {
    const p = await linkedPlayer();
    const error = await service(p.playerId, {
      issueCustomerToken: async () => ({
        customerId: `customer-${randomUUID()}`,
        tokenType: 'Bearer',
        expiresInMs: 60_000,
        get accessToken(): string {
          throw new Error(`${EMAIL} ${secret()}`);
        },
      }),
    })
      .openSession(p.userId, NO_CLIENT_META)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SupportChatUnavailableError);
    expect(warned()).toEqual([{ playerId: p.playerId, reason: 'malformed token answer' }]);
    expect(inspect([logged(), error], { depth: null, showHidden: true })).not.toMatch(LEAK);
  });
});

describe('SupportChatService sync path errors (real PG)', () => {
  it.each([
    ['a provider error with an unlisted reason and name', 'unlisted reason', leakingProviderError],
    ['a raw client error', 'unexpected adapter error', rawClientError],
    ['a listed code whose cause holds vendor detail', 'timeout', listedWithCause],
  ])('rethrows %s as a sync failure carrying `%s` only', async (_case, reason, thrown) => {
    const { error } = await failedSync(async () => {
      throw thrown();
    });

    expect(error).toBeInstanceOf(SupportChatSyncFailedError);
    expect((error as Error).message).toBe(`support-chat provider failed: ${reason}`);
    expect((error as Error).cause).toBeUndefined();
    expect(inspect([logged(), error], { depth: null })).not.toMatch(LEAK);
  });

  it('wraps an adapter that throws before handing back a promise', async () => {
    const { error } = await failedSync(() => {
      throw rawClientError();
    });

    expect(error).toBeInstanceOf(SupportChatSyncFailedError);
    expect((error as Error).message).toBe('support-chat provider failed: unexpected adapter error');
    expect((error as Error).cause).toBeUndefined();
    expect(inspect([logged(), error], { depth: null })).not.toMatch(LEAK);
  });
});

// Adapter errors shaped to slip past a sanitizer that trusts `name`, `message`, `stack`, a
// getter or a `cause` chain.
describe('SupportChatService adapter error shapes (real PG)', () => {
  const dirt = () => `${EMAIL} ${secret()}`;

  const deepCause = (depth: number) => {
    let cause: unknown = new Error(dirt());
    for (let level = 0; level < depth; level++) {
      cause = Object.assign(new Error(dirt(), { cause }), { name: dirt() });
    }
    return cause;
  };

  // A reason that is a getter, as a subclass or a proxy-like adapter error would expose it.
  const getterProviderError = () => {
    const err = new SupportChatProviderError('timeout');
    Object.defineProperty(err, 'reason', { get: dirt });
    return err;
  };

  // Passes the listed-code check on the first read and leaks on the second.
  const flippingProviderError = () => {
    let reads = 0;
    const err = new SupportChatProviderError('timeout');
    Object.defineProperty(err, 'reason', { get: () => (reads++ === 0 ? 'timeout' : dirt()) });
    return err;
  };

  const throwingReasonError = () => {
    const err = new SupportChatProviderError('timeout');
    Object.defineProperty(err, 'reason', {
      get: () => {
        throw new Error(dirt());
      },
    });
    return err;
  };

  // Even `instanceof` throws on it: the prototype lookup is a trap.
  const throwingPrototypeProxy = () =>
    new Proxy(new SupportChatProviderError('timeout'), {
      getPrototypeOf: () => {
        throw new Error(dirt());
      },
    });

  const shapes: [string, string, () => unknown][] = [
    ['a reason getter that throws', 'unexpected adapter error', throwingReasonError],
    ['a proxy whose prototype lookup throws', 'unexpected adapter error', throwingPrototypeProxy],
    [
      'a message and stack holding the secret',
      'unexpected adapter error',
      () => Object.assign(new Error(dirt()), { stack: `Error: ${dirt()}\n    at vendor` }),
    ],
    ['a reason that is a getter returning text', 'unlisted reason', getterProviderError],
    ['a reason getter that is listed once, then leaks', 'timeout', flippingProviderError],
    [
      'a listed code over a six-level cause chain',
      'timeout',
      () => new SupportChatProviderError('timeout', { cause: deepCause(6) }),
    ],
    [
      'a raw error over a six-level cause chain',
      'unexpected adapter error',
      () => new Error(dirt(), { cause: deepCause(6) }),
    ],
  ];

  it.each(shapes)('token path: %s logs `%s` only', async (_shape, reason, thrown) => {
    const { playerId, error } = await refusedToken(thrown);

    expect(error).toBeInstanceOf(SupportChatUnavailableError);
    expect(warned()).toEqual([{ playerId, reason }]);
    expect(inspect([logged(), error], { depth: null, showHidden: true })).not.toMatch(LEAK);
  });

  it.each(shapes)('sync path: %s rethrows `%s` only', async (_shape, reason, thrown) => {
    const { error } = await failedSync(async () => {
      throw thrown();
    });

    expect(error).toBeInstanceOf(SupportChatSyncFailedError);
    expect((error as Error).message).toBe(`support-chat provider failed: ${reason}`);
    expect((error as Error).cause).toBeUndefined();
    expect(inspect([logged(), error], { depth: null, showHidden: true })).not.toMatch(LEAK);
  });
});

describe('SupportChatService sync path core errors (real PG)', () => {
  it('lets a context that keeps moving surface as itself, not as an adapter failure', async () => {
    const p = await linkedPlayer();
    const error = await service(p.playerId, {
      // Every write lands, then the player's name changes under it, so the re-read never settles.
      syncCustomer: async () => {
        await db.drizzle.db
          .update(user)
          .set({ username: `moved-${randomUUID()}` })
          .where(eq(user.id, p.userId));
      },
    })
      .syncCustomer(p.userId)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SupportContextNotSettledError);
    expect(error).not.toBeInstanceOf(SupportChatSyncFailedError);
    expect(inspect([logged(), error], { depth: null })).not.toContain('unexpected adapter error');
  });
});

describe('SupportChatService offline ticket (real PG)', () => {
  const MESSAGE = 'my withdrawal is stuck';

  it('answers 200 when the audit write fails after the ticket is created, logging no message', async () => {
    const { account, player } = await seedPlayerWithUser(db);
    const createTicket = vi.fn(async () => ({ ticketId: `ticket-${randomUUID()}` }));
    const audit = makeAuditWriter();
    audit.record.mockRejectedValueOnce(new Error(`audit down for ${account.email}`));

    await expect(
      service(player.id, { createTicket }, audit).createTicket(account.id, MESSAGE, NO_CLIENT_META),
    ).resolves.toBeUndefined();
    expect(createTicket).toHaveBeenCalledOnce();
    expect(log.error.mock.calls).toEqual([
      [{ err: { name: 'Error' }, playerId: player.id }, expect.any(String)],
    ]);
    expect(inspect(logged(), { depth: null })).not.toContain(account.email);
  });

  it.each<[string, (email: string) => unknown]>([
    [
      'a ticket id getter that throws an error carrying the email',
      (email) =>
        Object.defineProperty({}, 'ticketId', {
          get() {
            throw new Error(`vendor says ${email}: ${MESSAGE}`);
          },
        }),
    ],
    [
      'a ticket id that is the vendor ticket holding the email',
      (email) => ({
        ticketId: { id: 7, requester: { email }, description: MESSAGE },
      }),
    ],
  ])('logs a malformed answer of %s as its reason only', async (_case, answer) => {
    const { account, player } = await seedPlayerWithUser(db);
    const createTicket = mock<NonNullable<SupportChatProvider['createTicket']>>(async () =>
      answer(account.email),
    );

    await service(player.id, { createTicket }).createTicket(account.id, MESSAGE, NO_CLIENT_META);

    expect(warned()).toEqual([{ playerId: player.id, reason: 'malformed ticket answer' }]);
    const seen = inspect(logged(), { depth: null, showHidden: true });
    expect(seen).not.toContain(account.email);
    expect(seen).not.toContain(MESSAGE);
  });

  it('logs a raw adapter error holding the email and the message as unexpected only', async () => {
    const { account, player } = await seedPlayerWithUser(db);
    const audit = makeAuditWriter();
    const error = await service(
      player.id,
      {
        createTicket: async () => {
          throw new Error(`ticket for ${account.email} failed: ${MESSAGE} ${secret()}`);
        },
      },
      audit,
    )
      .createTicket(account.id, MESSAGE, NO_CLIENT_META)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SupportChatUnavailableError);
    expect(warned()).toEqual([{ playerId: player.id, reason: 'unexpected adapter error' }]);
    const seen = inspect([logged(), error], { depth: null, showHidden: true });
    expect(seen).not.toContain(account.email);
    expect(seen).not.toContain(MESSAGE);
    expect(seen).not.toMatch(LEAK);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
