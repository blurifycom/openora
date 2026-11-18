import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  Container,
  DRIZZLE,
  EVENT_BUS,
  ModuleRegistryImpl,
  findOneOrThrow,
  moneyScaleBy,
  type CoreTokenCatalog,
} from '@openora/core/server';
import {
  ADMIN_USER_DIRECTORY,
  AUDIT_WRITER,
  EXCHANGE_RATE_READER,
  IDENTITY_READER,
  PLAYER_SEGMENT_READER,
  PLAY_ELIGIBILITY,
  RATE_LIMITER,
  KYC_WITHDRAWAL_POLICY,
  PLAYER_TAGS,
  WITHDRAWAL_SECURITY,
  type KycWithdrawalPolicy,
  type PlayerTags,
  type AdminPlayerSummary,
  type AdminUserDirectory,
  type ExchangeRateReader,
  type IdentityReader,
  type KycStatus,
  type PlayEligibilityPort,
  type PlayerSegmentReader,
  type RateLimiterAdapter,
  type RunContext,
  TagKeySchema,
} from '@openora/core/contracts';
import { createMcpKernel, createTestDb, type TestDb } from '@openora/core/testing';
import {
  makeAuditWriter,
  makeEventBus,
  makeIdentityReader,
  makeWithdrawalSecurity,
  mock,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletAutoWithdrawalConfig, walletTransaction } from '../schema/index.js';
import walletPlugin from '../plugin.js';

let db: TestDb;

const HOUR_MS = 60 * 60 * 1000;
const REVIEW_NOTE = 'SAR filed: structuring across linked accounts';
const PAYOUT_ADDRESS = 'bc1qoperatortoolsdestination0000000000000';
const PAYOUT_HASH = '0xfeedfacecafebeef';
const WINDOW_A = { from: '2026-01-01', to: '2026-03-31' };
const WINDOW_B = { from: '2026-04-01', to: '2026-06-29' };
const SEGMENT_PAGE = 2;
const DIRECTORY_NAME = 'queue-player';
const DIRECTORY_EMAIL_DOMAIN = 'operator-tools.test';

type Seeded = { playerId: string; userId: string; walletId: string };

const userIdByPlayer = new Map<string, string>();
const directoryEntries = new Map<string, AdminPlayerSummary>();
let segment: string[] = [];
let segmentCount: number | null = null;

function identityReader(): IdentityReader {
  return {
    ...makeIdentityReader(),
    getUserIdsByPlayerIds: vi.fn(
      async (playerIds: readonly string[]) =>
        new Map(
          playerIds.flatMap((id) => {
            const userId = userIdByPlayer.get(id);
            return userId ? [[id, userId] as const] : [];
          }),
        ),
    ),
  };
}

function segmentReader(): PlayerSegmentReader {
  return {
    describe: vi.fn(async (tags: readonly string[]) =>
      tags.map((tag) => ({
        tag: TagKeySchema.parse(tag),
        name: tag,
        playerCount: segmentCount ?? segment.length,
      })),
    ),
    page: vi.fn(async ({ after }) => {
      const ordered = [...segment].sort();
      const rest = after === undefined ? ordered : ordered.filter((id) => id > after);
      const playerIds = rest.slice(0, SEGMENT_PAGE);
      return { playerIds, next: rest.length > SEGMENT_PAGE ? (playerIds.at(-1) ?? null) : null };
    }),
    resolve: vi.fn(async () => new Map()),
  };
}

const EUR_RATE = '2';

const eurOnlyRates = (): ExchangeRateReader => ({
  getRate: vi.fn(async (from: string) =>
    from.toUpperCase() === 'EUR' ? { rate: EUR_RATE, asOf: new Date().toISOString() } : null,
  ),
  convert: vi.fn(async (amount: string, from: string) =>
    from.toUpperCase() === 'EUR' ? moneyScaleBy(amount, EUR_RATE) : null,
  ),
});

function bootKernel() {
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => makeEventBus());
  container.register(AUDIT_WRITER, () => makeAuditWriter());
  container.register(IDENTITY_READER, () => identityReader());
  container.register(PLAY_ELIGIBILITY, () => mock<PlayEligibilityPort>({}));
  container.register(ADMIN_USER_DIRECTORY, () =>
    mock<AdminUserDirectory>({
      lookupPlayers: vi.fn(async (userIds: readonly string[]) =>
        userIds.flatMap((id) => directoryEntries.get(id) ?? []),
      ),
    }),
  );
  container.register(RATE_LIMITER, () => mock<RateLimiterAdapter<string>>({}));
  container.register(PLAYER_TAGS, () => mock<PlayerTags>({}));
  container.register(KYC_WITHDRAWAL_POLICY, () => mock<KycWithdrawalPolicy>({}));
  container.register(WITHDRAWAL_SECURITY, () => makeWithdrawalSecurity());
  container.register(PLAYER_SEGMENT_READER, () => segmentReader());
  container.register(EXCHANGE_RATE_READER, () => eurOnlyRates());
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  registry.setOwner('wallet');
  walletPlugin.register(registry);
  return createMcpKernel({
    tools: registry.mcp.getTools(),
    actions: registry.actions.getAll(),
    container,
    authorize: async () => 'allowed',
    audit: makeAuditWriter(),
  });
}

const runContext = (): RunContext => ({
  runId: randomUUID(),
  actor: { kind: 'admin', adminId: randomUUID() },
  catalogVersion: 'test',
  correlationId: 'wallet-operator-tools',
});

async function seedPlayer({ kycStatus }: { kycStatus?: KycStatus | null } = {}): Promise<Seeded> {
  const playerId = randomUUID();
  const record = findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), currency: 'USD' })
      .returning(),
    new Error('seedPlayer: query returned no row'),
  );
  userIdByPlayer.set(playerId, record.userId);
  if (kycStatus !== undefined) {
    directoryEntries.set(record.userId, {
      playerId,
      userId: record.userId,
      username: `${DIRECTORY_NAME}-${playerId}`,
      email: `${playerId}@${DIRECTORY_EMAIL_DOMAIN}`,
      kycStatus,
      language: null,
      avatarUrl: null,
      createdAt: new Date(),
      level: 1,
      currency: 'USD',
    });
  }
  return { playerId, userId: record.userId, walletId: record.id };
}

async function seedTx(
  walletId: string,
  values: Pick<typeof walletTransaction.$inferInsert, 'type' | 'amount'> &
    Partial<typeof walletTransaction.$inferInsert>,
) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(walletTransaction)
      .values({ walletId, currency: 'USD', status: 'completed', ...values })
      .returning(),
    new Error('seedTx: query returned no row'),
  );
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS);

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  userIdByPlayer.clear();
  directoryEntries.clear();
  segment = [];
  segmentCount = null;
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${wallet}, ${walletAutoWithdrawalConfig} RESTART IDENTITY CASCADE`,
  );
});

describe('withdrawals.queue through the MCP kernel (real PG)', () => {
  let frequent: Seeded;
  let held: Seeded;
  let unknown: Seeded;
  let heldId: string;
  let frequentId: string;
  let unknownId: string;

  beforeEach(async () => {
    await db.drizzle.db
      .insert(walletAutoWithdrawalConfig)
      .values({ fiatThreshold: '100', cryptoThreshold: '1' });
    frequent = await seedPlayer({ kycStatus: 'approved' });
    held = await seedPlayer({ kycStatus: 'verified' });
    unknown = await seedPlayer();
    frequentId = (
      await seedTx(frequent.walletId, {
        type: 'withdrawal',
        amount: '100',
        status: 'pending',
        createdAt: hoursAgo(5),
        destinationAddress: PAYOUT_ADDRESS,
      })
    ).id;
    await seedTx(frequent.walletId, { type: 'withdrawal', amount: '40', createdAt: hoursAgo(20) });
    await seedTx(frequent.walletId, {
      type: 'withdrawal',
      amount: '30',
      status: 'processing',
      createdAt: hoursAgo(3),
    });
    heldId = (
      await seedTx(held.walletId, {
        type: 'withdrawal',
        amount: '6000',
        status: 'on_hold',
        createdAt: hoursAgo(10),
        reviewReason: REVIEW_NOTE,
        destinationAddress: PAYOUT_ADDRESS,
        txHash: PAYOUT_HASH,
      })
    ).id;
    unknownId = (
      await seedTx(unknown.walletId, {
        type: 'withdrawal',
        amount: '1',
        currency: 'BTC',
        status: 'pending',
        createdAt: hoursAgo(2),
      })
    ).id;
  });

  it('counts the queue and lists the longest waiting first, with no review note, address or hash', async () => {
    const result = await bootKernel().invokeTool('withdrawals.queue', {}, runContext());

    expect(result).toEqual({
      ok: true,
      output: {
        pendingCount: 2,
        onHoldCount: 1,
        queuedTotals: [
          { currency: 'BTC', amount: '1.000000000000000000' },
          { currency: 'USD', amount: '6100.000000000000000000' },
        ],
        avgPendingWaitHours: 3.5,
        oldest: [
          {
            withdrawalId: heldId,
            playerId: held.playerId,
            amount: '6000.000000000000000000',
            currency: 'USD',
            status: 'on_hold',
            requestedAt: expect.any(String),
            waitHours: 10,
            kycStatus: 'approved',
            riskTags: ['large_amount'],
          },
          {
            withdrawalId: frequentId,
            playerId: frequent.playerId,
            amount: '100.000000000000000000',
            currency: 'USD',
            status: 'pending',
            requestedAt: expect.any(String),
            waitHours: 5,
            kycStatus: 'approved',
            riskTags: ['high_frequency'],
          },
          {
            withdrawalId: unknownId,
            playerId: null,
            amount: '1.000000000000000000',
            currency: 'BTC',
            status: 'pending',
            requestedAt: expect.any(String),
            waitHours: 2,
            kycStatus: null,
            riskTags: ['large_amount'],
          },
        ],
      },
    });
    const served = JSON.stringify(result);
    expect(served).not.toContain(REVIEW_NOTE);
    expect(served).not.toContain(PAYOUT_ADDRESS);
    expect(served).not.toContain(PAYOUT_HASH);
    expect(served).not.toContain(frequent.userId);
    expect(served).not.toContain(DIRECTORY_NAME);
    expect(served).not.toContain(DIRECTORY_EMAIL_DOMAIN);
  });

  it('narrows the oldest to one status and refuses a limit above 20', async () => {
    const kernel = bootKernel();

    const pending = await kernel.invokeTool(
      'withdrawals.queue',
      { status: 'pending', limit: '1' },
      runContext(),
    );
    const tooMany = await kernel.invokeTool('withdrawals.queue', { limit: 21 }, runContext());

    expect(pending).toMatchObject({
      ok: true,
      output: { pendingCount: 2, onHoldCount: 1, oldest: [{ withdrawalId: frequentId }] },
    });
    expect(pending.ok && pending.output['oldest']).toHaveLength(1);
    expect(tooMany).toMatchObject({ ok: false, error: 'invalid_input' });
  });
});

describe('players.deposit_compare through the MCP kernel (real PG)', () => {
  let steady: Seeded;
  let euro: Seeded;
  let released: Seeded;

  beforeEach(async () => {
    steady = await seedPlayer();
    euro = await seedPlayer();
    const riser = await seedPlayer();
    released = await seedPlayer();
    const unpriced = await seedPlayer();
    const idle = await seedPlayer();
    const outside = await seedPlayer();
    const notTagged = await seedPlayer();
    segment = [steady, euro, riser, released, unpriced, idle, outside].map((p) => p.playerId);

    await seedTx(steady.walletId, {
      type: 'deposit',
      amount: '100',
      createdAt: new Date('2026-01-15T10:00:00Z'),
    });
    await seedTx(steady.walletId, {
      type: 'deposit',
      amount: '40',
      createdAt: new Date('2026-04-10T10:00:00Z'),
    });
    await seedTx(steady.walletId, {
      type: 'deposit',
      amount: '500',
      status: 'pending',
      createdAt: new Date('2026-04-11T10:00:00Z'),
    });
    await seedTx(euro.walletId, {
      type: 'deposit',
      amount: '100',
      currency: 'EUR',
      createdAt: new Date('2026-03-31T23:59:59Z'),
    });
    await seedTx(euro.walletId, {
      type: 'deposit',
      amount: '25',
      currency: 'EUR',
      createdAt: new Date('2026-06-29T23:00:00Z'),
    });
    await seedTx(riser.walletId, {
      type: 'deposit',
      amount: '10',
      createdAt: new Date('2026-02-01T10:00:00Z'),
    });
    await seedTx(riser.walletId, {
      type: 'deposit',
      amount: '30',
      createdAt: new Date('2026-05-01T10:00:00Z'),
    });
    await seedTx(released.walletId, {
      type: 'deposit',
      amount: '70',
      createdAt: new Date('2026-03-30T10:00:00Z'),
      reviewedAt: new Date('2026-04-02T10:00:00Z'),
    });
    await seedTx(unpriced.walletId, {
      type: 'deposit',
      amount: '1',
      currency: 'BTC',
      createdAt: new Date('2026-01-20T10:00:00Z'),
    });
    await seedTx(unpriced.walletId, {
      type: 'deposit',
      amount: '5',
      createdAt: new Date('2026-04-20T10:00:00Z'),
    });
    await seedTx(outside.walletId, {
      type: 'deposit',
      amount: '900',
      createdAt: new Date('2026-06-30T00:00:00Z'),
    });
    await seedTx(notTagged.walletId, {
      type: 'deposit',
      amount: '5000',
      createdAt: new Date('2026-01-10T10:00:00Z'),
    });
  });

  it('ranks the largest drops in the pivot currency and totals every priced player', async () => {
    const result = await bootKernel().invokeTool(
      'players.deposit_compare',
      { tag: 'vip', windowA: WINDOW_A, windowB: WINDOW_B },
      runContext(),
    );

    expect(result).toEqual({
      ok: true,
      output: {
        tag: 'vip',
        playersInSegment: 7,
        pivotCurrency: 'USD',
        totals: { windowA: '310.000000000000000000', windowB: '190.000000000000000000' },
        players: [
          {
            playerId: euro.playerId,
            depositsA: '200.000000000000000000',
            depositsB: '50.000000000000000000',
            change: '-150.000000000000000000',
            changePct: -75,
          },
          {
            playerId: steady.playerId,
            depositsA: '100.000000000000000000',
            depositsB: '40.000000000000000000',
            change: '-60.000000000000000000',
            changePct: -60,
          },
        ],
        unpricedPlayers: 1,
        truncated: false,
      },
    });
  });

  it('ranks the largest rises, a deposit released from a hold counting on its release day', async () => {
    const result = await bootKernel().invokeTool(
      'players.deposit_compare',
      { tag: 'vip', windowA: WINDOW_A, windowB: WINDOW_B, order: 'largest_rise', limit: '1' },
      runContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        players: [
          {
            playerId: released.playerId,
            depositsA: '0',
            depositsB: '70.000000000000000000',
            changePct: null,
          },
        ],
        truncated: true,
      },
    });
  });

  it('refuses a segment larger than it reads, and a window longer than 92 days', async () => {
    segmentCount = 20_001;
    const kernel = bootKernel();

    const tooLarge = await kernel.invokeTool(
      'players.deposit_compare',
      { tag: 'vip', windowA: WINDOW_A, windowB: WINDOW_B },
      runContext(),
    );
    const tooLong = await kernel.invokeTool(
      'players.deposit_compare',
      { tag: 'vip', windowA: WINDOW_A, windowB: { from: '2026-04-01', to: '2026-07-02' } },
      runContext(),
    );

    expect(tooLarge).toEqual({ ok: false, error: 'segment_too_large' });
    expect(tooLong).toMatchObject({ ok: false, error: 'invalid_input' });
  });
});
