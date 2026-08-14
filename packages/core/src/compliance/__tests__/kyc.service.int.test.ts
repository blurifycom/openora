import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import type {
  KycAdapter,
  KycStatusWriter,
  KycVendorStatus,
  PlatformConfig,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { makeIdentityReader, mock, makeEventBus } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { kycVerification } from '../schema/index.js';
import { KycVerificationService } from '../service/kyc.service.js';

let db: TestDb;

type AdapterResult = { referenceId: string; status: KycVendorStatus; verificationUrl?: string };

function makeService(options: { adapter?: Partial<AdapterResult>; config?: PlatformConfig } = {}) {
  const events = makeEventBus();
  const adapterResult: AdapterResult = {
    referenceId: randomUUID(),
    status: 'approved',
    ...options.adapter,
  };
  const kycAdapter = mock<KycAdapter>({
    submit: vi.fn(async () => adapterResult),
    getStatus: vi.fn(async () => adapterResult.status),
  });
  const statusWriter = mock<KycStatusWriter>({ setStatus: vi.fn(async () => undefined) });
  const svc = new KycVerificationService({
    drizzle: db.drizzle,
    events: events,
    kycAdapter,
    statusWriter,
    identityReader: makeIdentityReader(),
    ...(options.config ? { platformConfig: options.config } : {}),
  });
  return { svc, events, kycAdapter, statusWriter, adapterResult };
}

const passportSubmission = { documents: [{ type: 'passport' as const, frontUrl: 'https://f' }] };

async function seedPlayer(overrides: Partial<typeof player.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(player)
    .values({
      userId: randomUUID(),
      displayName: 'Player',
      currency: 'USD',
      kycStatus: 'verified',
      ...overrides,
    })
    .returning();
  return row!;
}

async function seedDeposit(userId: string, amount: string, currency = 'USD') {
  const [walletRow] = await db.drizzle.db
    .insert(wallet)
    .values({ userId, balance: amount, currency })
    .onConflictDoNothing()
    .returning();
  const [existing] = await db.drizzle.db.select().from(wallet).where(eq(wallet.userId, userId));
  await db.drizzle.db.insert(walletTransaction).values({
    walletId: (walletRow ?? existing)!.id,
    type: 'deposit',
    amount,
    currency,
    status: 'completed',
  });
}

async function verificationsOf(userId: string) {
  return db.drizzle.db
    .select()
    .from(kycVerification)
    .where(eq(kycVerification.userId, userId))
    .orderBy(desc(kycVerification.createdAt));
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile, migrateWallet]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${kycVerification}, ${walletTransaction}, ${wallet}, ${player} RESTART IDENTITY CASCADE`,
  );
});

describe('KycVerificationService.submit (real PG)', () => {
  it('appends a decided record, emits submitted, and pushes the status through the writer', async () => {
    const { svc, events, statusWriter, adapterResult } = makeService();
    const userId = randomUUID();

    const result = await svc.submit(userId, passportSubmission);

    const rows = await verificationsOf(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      referenceId: adapterResult.referenceId,
      status: 'approved',
      triggeredBy: 'submission',
      documentTypes: ['passport'],
    });
    expect(rows[0]?.decidedAt).toBeInstanceOf(Date);
    expect(result.status).toBe('approved');
    expect(events.emit).toHaveBeenCalledWith(
      'compliance.kyc.submitted',
      expect.objectContaining({ userId, referenceId: adapterResult.referenceId }),
    );
    expect(statusWriter.setStatus).toHaveBeenCalledWith(
      userId,
      'approved',
      { actorId: null, source: 'vendor' },
      expect.anything(),
    );
    const statusCallOrder = vi.mocked(statusWriter.setStatus).mock.invocationCallOrder[0];
    const emitCallOrder = vi.mocked(events.emit).mock.invocationCallOrder[0];
    expect(statusCallOrder).toEqual(expect.any(Number));
    expect(emitCallOrder).toEqual(expect.any(Number));
    expect(statusCallOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(emitCallOrder ?? 0);
  });

  it('leaves decidedAt unset while the vendor is still deciding', async () => {
    const { svc } = makeService({ adapter: { status: 'pending' } });
    const userId = randomUUID();

    await svc.submit(userId, passportSubmission);

    const [row] = await verificationsOf(userId);
    expect(row).toMatchObject({ status: 'pending', decidedAt: null });
  });

  it('updates the existing verification when the vendor reuses a reference id', async () => {
    const { svc } = makeService();
    const userId = randomUUID();

    await svc.submit(userId, passportSubmission);
    await svc.submit(userId, passportSubmission);

    expect(await verificationsOf(userId)).toHaveLength(1);
  });

  it('passes a hosted-session verificationUrl through', async () => {
    const { svc } = makeService({
      adapter: { status: 'pending', verificationUrl: 'https://vendor/session' },
    });

    const result = await svc.submit(randomUUID(), passportSubmission);

    expect(result.verificationUrl).toBe('https://vendor/session');
  });

  it('omits verificationUrl when the adapter does not return one', async () => {
    const { svc } = makeService();

    const result = await svc.submit(randomUUID(), passportSubmission);

    expect(result.verificationUrl).toBeUndefined();
  });
});

describe('KycVerificationService.reconcile (real PG)', () => {
  it('maps an approved vendor decision onto verified and notifies the writer', async () => {
    const { svc, statusWriter, adapterResult } = makeService({ adapter: { status: 'pending' } });
    const userId = randomUUID();
    await svc.submit(userId, passportSubmission);

    const result = await svc.reconcile(adapterResult.referenceId, 'approved', {
      reason: 'docs ok',
    });

    expect(result).toMatchObject({ status: 'approved', decisionReason: 'docs ok' });
    expect(statusWriter.setStatus).toHaveBeenLastCalledWith(
      userId,
      'approved',
      expect.objectContaining({ source: 'webhook', reason: 'docs ok' }),
      expect.anything(),
    );
  });

  it('maps a rejected vendor decision onto rejected', async () => {
    const { svc, adapterResult } = makeService({ adapter: { status: 'pending' } });
    await svc.submit(randomUUID(), passportSubmission);

    const result = await svc.reconcile(adapterResult.referenceId, 'rejected', {
      reason: 'blurry scan',
    });

    expect(result?.status).toBe('rejected');
  });

  it('is idempotent when the record already holds the mapped decision', async () => {
    const { svc, statusWriter, adapterResult } = makeService();
    await svc.submit(randomUUID(), passportSubmission);
    statusWriter.setStatus = vi.fn(async () => undefined);

    await svc.reconcile(adapterResult.referenceId, 'approved');

    expect(statusWriter.setStatus).not.toHaveBeenCalled();
  });

  it('returns null for an unknown reference id', async () => {
    const { svc } = makeService();

    expect(await svc.reconcile(randomUUID(), 'approved')).toBeNull();
  });
});

describe('KycVerificationService.getForPlayer (real PG)', () => {
  it('returns the newest record as current with the full history behind it', async () => {
    const { svc } = makeService({ adapter: { status: 'pending' } });
    const userId = randomUUID();
    await svc.submit(userId, passportSubmission);
    await db.drizzle.db
      .update(kycVerification)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(kycVerification.userId, userId));
    const { svc: second, adapterResult } = makeService({ adapter: { status: 'pending' } });
    await second.submit(userId, passportSubmission);

    const view = await svc.getForPlayer(userId);

    expect(view.history).toHaveLength(2);
    expect(view.current?.referenceId).toBe(adapterResult.referenceId);
  });

  it('returns an empty view for a player with no submissions', async () => {
    const { svc } = makeService();

    expect(await svc.getForPlayer(randomUUID())).toEqual({ current: null, history: [] });
  });
});

describe('KycVerificationService.handleDeposit - threshold re-KYC (real PG)', () => {
  const config = mock<PlatformConfig>({ kyc: { reverifyThresholds: { USD: '500' } } });

  it('flips a verified player to resubmission_requested once deposits cross the band', async () => {
    const { svc, events, statusWriter } = makeService({ config });
    const { userId } = await seedPlayer();
    await seedDeposit(userId, '1000');

    await svc.handleDeposit(userId);

    const [row] = await verificationsOf(userId);
    expect(row).toMatchObject({
      status: 'resubmission_requested',
      triggeredBy: 'reverify_threshold',
    });
    expect(Number(row?.triggerDeposits)).toBe(1000);
    expect(statusWriter.setStatus).toHaveBeenCalledWith(
      userId,
      'resubmission_requested',
      expect.objectContaining({ source: 'reverify' }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'compliance.kyc.reverify_required',
      expect.objectContaining({ userId }),
    );
  });

  it('does not fire below the threshold', async () => {
    const { svc, statusWriter } = makeService({ config });
    const { userId } = await seedPlayer();
    await seedDeposit(userId, '100');

    await svc.handleDeposit(userId);

    expect(statusWriter.setStatus).not.toHaveBeenCalled();
    expect(await verificationsOf(userId)).toHaveLength(0);
  });

  it('does not fire when the player is already out of the verified pass-set', async () => {
    const { svc, statusWriter } = makeService({ config });
    const { userId } = await seedPlayer({ kycStatus: 'resubmission_requested' });
    await seedDeposit(userId, '2000');

    await svc.handleDeposit(userId);

    expect(statusWriter.setStatus).not.toHaveBeenCalled();
  });

  it('ignores deposits in another currency than the player account', async () => {
    const { svc, statusWriter } = makeService({ config });
    const { userId } = await seedPlayer({ currency: 'EUR' });
    await seedDeposit(userId, '2000', 'EUR');

    await svc.handleDeposit(userId);

    expect(statusWriter.setStatus).not.toHaveBeenCalled();
  });

  it('ignores a pending deposit that has not settled', async () => {
    const { svc, statusWriter } = makeService({ config });
    const { userId } = await seedPlayer();
    const [walletRow] = await db.drizzle.db
      .insert(wallet)
      .values({ userId, balance: '0', currency: 'USD' })
      .returning();
    await db.drizzle.db.insert(walletTransaction).values({
      walletId: walletRow!.id,
      type: 'deposit',
      amount: '2000',
      currency: 'USD',
      status: 'pending',
    });

    await svc.handleDeposit(userId);

    expect(statusWriter.setStatus).not.toHaveBeenCalled();
  });

  it('does not re-fire inside the same band once the watermark is written', async () => {
    const { svc } = makeService({ config });
    const { userId } = await seedPlayer();
    await seedDeposit(userId, '600');
    await svc.handleDeposit(userId);
    await db.drizzle.db
      .update(player)
      .set({ kycStatus: 'verified' })
      .where(eq(player.userId, userId));
    await seedDeposit(userId, '50');

    await svc.handleDeposit(userId);

    expect(await verificationsOf(userId)).toHaveLength(1);
  });

  it('fires again once a fresh band is crossed', async () => {
    const { svc } = makeService({ config });
    const { userId } = await seedPlayer();
    await seedDeposit(userId, '600');
    await svc.handleDeposit(userId);
    await db.drizzle.db
      .update(player)
      .set({ kycStatus: 'verified' })
      .where(eq(player.userId, userId));
    await seedDeposit(userId, '600');

    await svc.handleDeposit(userId);

    expect(await verificationsOf(userId)).toHaveLength(2);
  });

  it('is a no-op for a user with no player profile', async () => {
    const { svc, statusWriter } = makeService({ config });

    await svc.handleDeposit(randomUUID());

    expect(statusWriter.setStatus).not.toHaveBeenCalled();
  });

  it('never fires when no thresholds are configured', async () => {
    const { svc, statusWriter } = makeService();
    const { userId } = await seedPlayer();
    await seedDeposit(userId, '99999');

    await svc.handleDeposit(userId);

    expect(statusWriter.setStatus).not.toHaveBeenCalled();
  });
});
