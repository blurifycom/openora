import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { PlayerKycSummaryViewSchema } from '@openora/core/compliance/contract';
import { auditLog } from '@openora/core/audit/schema';
import { newFundedPlayer, postWithdrawal, waitForAudit, type WalletE2e } from './support/wallet.js';
import {
  adminKycView,
  bootKycE2e,
  closeKycE2e,
  newKycPlayer,
  openKycStream,
  playerKycStatus,
  postKycWebhook,
  rowsForReference,
  settleDecisionQueue,
  signKycBody,
  staffClient,
  submitKyc,
  submitKycOrThrow,
  verificationRows,
  waitForPlayerStatus,
  withGlobalKyc,
} from './support/kyc.js';
import { flushAudit } from '../index.js';
import type { KycDirective } from './support/test-kyc-plugin.js';

let e2e: WalletE2e;

beforeAll(async () => {
  e2e = await bootKycE2e();
}, 60_000);

afterAll(() => closeKycE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

async function submittedPlayer(directive: KycDirective = {}) {
  const player = await newKycPlayer(e2e);
  const { referenceId } = await submitKycOrThrow(player.client, directive);
  return { ...player, referenceId };
}

async function decide(directive: KycDirective) {
  const player = await submittedPlayer(directive);
  const res = await postKycWebhook(e2e, {
    referenceId: player.referenceId,
    status: directive.decision ?? 'approved',
  });
  expect(res.status).toBe(200);
  return player;
}

const yearsAgo = (years: number) => {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
};

const kycUpdatedAudit = async (playerId: string) => {
  await flushAudit(e2e.app);
  return db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'compliance.kyc.updated'), eq(auditLog.resourceId, playerId)));
};

const afterStatusOf = (row: { after: unknown }) =>
  z.object({ kycStatus: z.string() }).parse(row.after).kycStatus;

describe('KYC submission and vendor decisions', () => {
  it('player submits KYC and the status becomes pending with a vendor reference', async () => {
    const player = await newKycPlayer(e2e);

    const { status, body } = await submitKyc(player.client);

    expect(status).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({
        status: 'pending',
        tier: 'basic',
        userId: player.userId,
        referenceId: expect.stringMatching(/\S+/),
      }),
    );
    expect(await playerKycStatus(e2e, player.userId)).toBe('pending');
    const rows = await verificationRows(e2e, player.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.referenceId).toBe(
      z.object({ referenceId: z.string() }).parse(body).referenceId,
    );
  });

  it('player submits KYC again while a verification is in progress and is collapsed onto the same session', async () => {
    const player = await submittedPlayer();

    const again = await submitKycOrThrow(player.client);

    expect(again.referenceId).toBe(player.referenceId);
    expect(again.status).toBe('pending');
    const rows = await verificationRows(e2e, player.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.referenceId).toBe(player.referenceId);
    expect(await playerKycStatus(e2e, player.userId)).toBe('pending');
  });

  it('vendor webhook with an approved decision approves the player and emits the status change', async () => {
    const player = await submittedPlayer();

    const res = await postKycWebhook(e2e, { referenceId: player.referenceId, status: 'approved' });

    expect(res.status).toBe(200);
    await waitForPlayerStatus(e2e, player.userId, 'approved');
    const rows = await verificationRows(e2e, player.userId);
    expect(rows[0]).toEqual(
      expect.objectContaining({ status: 'approved', decidedAt: expect.any(Date) }),
    );
    const audit = await waitForAudit(e2e, 'compliance.kyc.updated', player.playerId);
    expect(audit.map(afterStatusOf)).toContain('approved');
    expect(audit.find((row) => afterStatusOf(row) === 'approved')?.before).toEqual(
      expect.objectContaining({ kycStatus: 'pending' }),
    );
  });

  it('vendor webhook with a rejected decision declines the player and keeps the block', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const { referenceId } = await submitKycOrThrow(player.client, { decision: 'rejected' });

    await withGlobalKyc(
      e2e.admin,
      { enabled: true, cumulativeDepositThreshold: '100' },
      async () => {
        const before = await postWithdrawal(player.client, player);
        expect(before.status).toBe(409);

        const res = await postKycWebhook(e2e, { referenceId, status: 'rejected' });
        expect(res.status).toBe(200);
        await waitForPlayerStatus(e2e, player.userId, 'rejected');

        const after = await postWithdrawal(player.client, player);
        expect(after.status).toBe(409);
        expect(after.body).toEqual(before.body);
      },
    );
    const rows = await verificationRows(e2e, player.userId);
    expect(rows[0]).toEqual(
      expect.objectContaining({ status: 'rejected', decidedAt: expect.any(Date) }),
    );
  });

  it('vendor webhook that is approved but has an incomplete check moves the player to resubmission requested', async () => {
    const player = await decide({
      decision: 'approved',
      checks: [
        { step: 'id_verification', status: 'approved' },
        { step: 'liveness', status: 'in_review' },
      ],
    });

    await waitForPlayerStatus(e2e, player.userId, 'resubmission_requested');
    const [row] = await verificationRows(e2e, player.userId);
    expect(row?.status).toBe('resubmission_requested');
    expect(row?.decisionReason).toContain('liveness');
    expect(row?.decidedAt).toBeNull();
  });

  it('vendor webhook for an underage player declines with the underage reason', async () => {
    const player = await decide({ decision: 'approved', dateOfBirth: yearsAgo(10) });

    await waitForPlayerStatus(e2e, player.userId, 'rejected');
    const [row] = await verificationRows(e2e, player.userId);
    expect(row).toEqual(
      expect.objectContaining({ status: 'rejected', decisionReason: 'underage' }),
    );
  });

  it('vendor webhook with an unreadable date of birth requests resubmission', async () => {
    const player = await decide({ decision: 'approved', dateOfBirth: 'not-a-date' });

    await waitForPlayerStatus(e2e, player.userId, 'resubmission_requested');
    const [row] = await verificationRows(e2e, player.userId);
    expect(row).toEqual(
      expect.objectContaining({
        status: 'resubmission_requested',
        decisionReason: 'date_of_birth_unreadable',
      }),
    );
  });

  it('vendor webhook with an invalid signature is rejected and changes nothing', async () => {
    const player = await submittedPlayer();
    const event = { referenceId: player.referenceId, status: 'approved' };

    const wrongSignature = await postKycWebhook(e2e, event, { signature: 'f'.repeat(64) });
    const otherBodySignature = await postKycWebhook(e2e, event, {
      signature: signKycBody('{"other":true}'),
    });
    const missingSignature = await e2e.app.app.request('/compliance/kyc/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });

    expect(wrongSignature.status).toBe(401);
    expect(otherBodySignature.status).toBe(401);
    expect(missingSignature.status).toBe(401);
    await settleDecisionQueue(e2e);
    expect(await playerKycStatus(e2e, player.userId)).toBe('pending');
    const [row] = await verificationRows(e2e, player.userId);
    expect(row).toEqual(expect.objectContaining({ status: 'pending', decidedAt: null }));
  });

  it('vendor webhook replayed with the same reference leaves a single decision row', async () => {
    const player = await submittedPlayer();
    const raw = JSON.stringify({
      referenceId: player.referenceId,
      status: 'approved',
      nonce: randomUUID(),
    });

    const first = await postKycWebhook(e2e, { referenceId: '', status: '' }, { raw });
    const byteIdentical = await postKycWebhook(e2e, { referenceId: '', status: '' }, { raw });
    const redelivered = await postKycWebhook(e2e, {
      referenceId: player.referenceId,
      status: 'approved',
    });

    expect(first.status).toBe(200);
    expect(byteIdentical.status).toBe(401);
    expect(redelivered.status).toBe(200);
    await waitForPlayerStatus(e2e, player.userId, 'approved');
    await settleDecisionQueue(e2e);
    expect(await rowsForReference(e2e, player.referenceId)).toHaveLength(1);
    expect(await verificationRows(e2e, player.userId)).toHaveLength(1);
    const approvals = (await kycUpdatedAudit(player.playerId)).filter(
      (row) => afterStatusOf(row) === 'approved',
    );
    expect(approvals).toHaveLength(1);
  });

  it('vendor webhook whose reference belongs to another player is refused', async () => {
    const shared = { ref: `shared-${randomUUID()}` };
    const first = await submittedPlayer(shared);
    const second = await submittedPlayer(shared);
    expect(second.referenceId).toBe(first.referenceId);

    const res = await postKycWebhook(e2e, { referenceId: first.referenceId, status: 'approved' });

    expect(res.status).toBe(200);
    await settleDecisionQueue(e2e);
    expect(await playerKycStatus(e2e, first.userId)).toBe('pending');
    expect(await playerKycStatus(e2e, second.userId)).toBe('pending');
    expect((await verificationRows(e2e, first.userId))[0]?.status).toBe('pending');
    expect((await verificationRows(e2e, second.userId))[0]?.status).toBe('pending');
  });

  it('vendor webhook whose tier disagrees with the stored verification is refused', async () => {
    const player = await submittedPlayer({ resolvedTier: 'advanced' });

    const res = await postKycWebhook(e2e, {
      referenceId: player.referenceId,
      status: 'approved',
      tier: 'basic',
    });

    expect(res.status).toBe(200);
    await settleDecisionQueue(e2e);
    expect(await playerKycStatus(e2e, player.userId)).toBe('pending');
    expect((await verificationRows(e2e, player.userId))[0]?.status).toBe('pending');
  });
});

describe('KYC status stream and views', () => {
  it('player stream receives the new status when a vendor decision lands', async () => {
    const player = await submittedPlayer();
    const stream = await openKycStream(player.client);
    try {
      await postKycWebhook(e2e, { referenceId: player.referenceId, status: 'approved' });

      await stream.waitFor('approved');
    } finally {
      await stream.close();
    }
  });

  it('player stream never receives another player status', async () => {
    const watcher = await submittedPlayer({ decision: 'rejected' });
    const other = await submittedPlayer();
    const stream = await openKycStream(watcher.client);
    try {
      await postKycWebhook(e2e, { referenceId: other.referenceId, status: 'approved' });
      await waitForPlayerStatus(e2e, other.userId, 'approved');
      await postKycWebhook(e2e, { referenceId: watcher.referenceId, status: 'rejected' });

      await stream.waitFor('rejected');
      expect(stream.statuses).not.toContain('approved');
    } finally {
      await stream.close();
    }
  });

  it('unauthenticated client cannot open the KYC status stream', async () => {
    const res = await e2e.app.app.request('/compliance/kyc/stream', {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    });

    expect(res.status).toBe(401);
  });

  it('player reads own KYC view with basic and enhanced sections', async () => {
    const player = await decide({ decision: 'approved' });
    await waitForPlayerStatus(e2e, player.userId, 'approved');
    await submitKycOrThrow(player.client, {}, 'advanced');

    const res = await player.client.get('/compliance/kyc/me');

    expect(res.status).toBe(200);
    const view = PlayerKycSummaryViewSchema.parse(await res.json());
    expect(view.basic.current?.status).toBe('approved');
    expect(view.basic.history).toHaveLength(1);
    expect(view.advanced.current?.status).toBe('pending');
    expect(view.advanced.history).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain(player.referenceId);
  });

  it('player cannot read another player KYC view and admin can', async () => {
    const owner = await submittedPlayer();
    const other = await newKycPlayer(e2e);

    const foreign = await other.client.get(`/compliance/players/${owner.userId}/kyc`);
    const byAdmin = await adminKycView(e2e.admin, owner.userId);

    expect(foreign.status).toBe(403);
    expect(byAdmin.basic.current).toEqual(
      expect.objectContaining({ referenceId: owner.referenceId, status: 'pending' }),
    );
  });
});

describe('Admin KYC actions', () => {
  it('admin requests resubmission and the player sees resubmission requested', async () => {
    const player = await newKycPlayer(e2e);
    const officer = await staffClient(e2e, 'compliance-manager');

    const res = await officer.post(`/compliance/players/${player.userId}/kyc/resubmit`, {
      userId: player.userId,
      tier: 'basic',
      reason: 'document is blurry',
    });

    expect(res.status).toBe(200);
    expect(await playerKycStatus(e2e, player.userId)).toBe('resubmission_requested');
    const view = PlayerKycSummaryViewSchema.parse(
      await (await player.client.get('/compliance/kyc/me')).json(),
    );
    expect(view.basic.current?.status).toBe('resubmission_requested');
  });

  it('admin requests resubmission twice and the repeat changes nothing', async () => {
    const player = await newKycPlayer(e2e);
    const officer = await staffClient(e2e, 'compliance-manager');
    const request = () =>
      officer.post(`/compliance/players/${player.userId}/kyc/resubmit`, {
        userId: player.userId,
        tier: 'basic',
        reason: 'document is blurry',
      });

    const first = await request();
    const second = await request();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await playerKycStatus(e2e, player.userId)).toBe('resubmission_requested');
    expect(await verificationRows(e2e, player.userId)).toHaveLength(1);
    const audit = await kycUpdatedAudit(player.playerId);
    expect(audit.filter((row) => afterStatusOf(row) === 'resubmission_requested')).toHaveLength(1);
  });

  it('admin requests resubmission while a verification is pending and gets a conflict', async () => {
    const player = await submittedPlayer();
    const officer = await staffClient(e2e, 'compliance-manager');

    const res = await officer.post(`/compliance/players/${player.userId}/kyc/resubmit`, {
      userId: player.userId,
      tier: 'basic',
      reason: 'too early',
    });

    expect(res.status).toBe(409);
    expect(await playerKycStatus(e2e, player.userId)).toBe('pending');
    expect(await verificationRows(e2e, player.userId)).toHaveLength(1);
  });

  it('admin overrides a player to approved and the status reads manually overridden', async () => {
    const player = await submittedPlayer();
    const officer = await staffClient(e2e, 'compliance-manager');

    const res = await officer.post(`/compliance/players/${player.userId}/kyc/override`, {
      userId: player.userId,
      tier: 'basic',
      status: 'approved',
      reason: 'verified by hand',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({ status: 'manually_overridden' }));
    expect(await playerKycStatus(e2e, player.userId)).toBe('manually_overridden');
    const audit = await waitForAudit(e2e, 'compliance.kyc.updated', player.playerId);
    expect(audit.map(afterStatusOf)).toContain('manually_overridden');
  });

  it('admin overrides a player that has no verification and a manual row records it', async () => {
    const player = await newKycPlayer(e2e);
    const officer = await staffClient(e2e, 'compliance-manager');

    const res = await officer.post(`/compliance/players/${player.userId}/kyc/override`, {
      userId: player.userId,
      tier: 'basic',
      status: 'approved',
      reason: 'verified offline',
    });

    expect(res.status).toBe(200);
    expect(await playerKycStatus(e2e, player.userId)).toBe('manually_overridden');
    const rows = await verificationRows(e2e, player.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        status: 'manually_overridden',
        triggeredBy: 'manual',
        decisionReason: 'verified offline',
      }),
    );
    const audit = await kycUpdatedAudit(player.playerId);
    expect(audit.map(afterStatusOf)).toContain('manually_overridden');
  });

  it('admin overrides a player that does not exist and gets not found', async () => {
    const officer = await staffClient(e2e, 'compliance-manager');
    const unknownUserId = randomUUID();

    const res = await officer.post(`/compliance/players/${unknownUserId}/kyc/override`, {
      userId: unknownUserId,
      tier: 'basic',
      status: 'approved',
      reason: 'no such player',
    });

    expect(res.status).toBe(404);
  });

  it('admin bulk-approves several players and each gets an audit row', async () => {
    const officer = await staffClient(e2e, 'compliance-manager');
    const players = await Promise.all([submittedPlayer(), submittedPlayer(), newKycPlayer(e2e)]);

    const res = await officer.post('/compliance/kyc/bulk-approve', {
      userIds: players.map((player) => player.userId),
      tier: 'basic',
      reason: 'bulk e2e',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: expect.arrayContaining(
        players.map((player) => ({ userId: player.userId, success: true, error: null })),
      ),
    });
    for (const player of players) {
      expect(await playerKycStatus(e2e, player.userId)).toBe('manually_overridden');
      const audit = await waitForAudit(e2e, 'compliance.kyc.updated', player.playerId);
      expect(audit.map(afterStatusOf)).toContain('manually_overridden');
    }
  });

  it('player cannot override, resubmit or bulk-approve', async () => {
    const attacker = await newKycPlayer(e2e);
    const victim = await submittedPlayer();
    const target = `/compliance/players/${victim.userId}/kyc`;

    const override = await attacker.client.post(`${target}/override`, {
      userId: victim.userId,
      tier: 'basic',
      status: 'approved',
      reason: 'self service',
    });
    const resubmit = await attacker.client.post(`${target}/resubmit`, {
      userId: victim.userId,
      tier: 'basic',
      reason: 'self service',
    });
    const bulk = await attacker.client.post('/compliance/kyc/bulk-approve', {
      userIds: [attacker.userId, victim.userId],
      tier: 'basic',
      reason: 'self service',
    });

    expect(override.status).toBe(403);
    expect(resubmit.status).toBe(403);
    expect(bulk.status).toBe(403);
    expect(await playerKycStatus(e2e, attacker.userId)).toBe('pending');
    expect(await verificationRows(e2e, attacker.userId)).toHaveLength(0);
    expect(await playerKycStatus(e2e, victim.userId)).toBe('pending');
  });

  it('admin requests enhanced KYC while a verification is in progress and gets a conflict', async () => {
    const player = await newKycPlayer(e2e);
    await submitKycOrThrow(player.client, {}, 'advanced');
    const officer = await staffClient(e2e, 'compliance-manager');

    const res = await officer.post(`/compliance/players/${player.userId}/kyc/resubmit`, {
      userId: player.userId,
      tier: 'advanced',
      reason: 'enhanced due diligence',
    });

    expect(res.status).toBe(409);
    const view = await adminKycView(e2e.admin, player.userId);
    expect(view.advanced.current?.status).toBe('pending');
    expect(view.advanced.history).toHaveLength(1);
  });
});
