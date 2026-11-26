import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, like, sql } from 'drizzle-orm';
import z from 'zod';
import { DRIZZLE, eventOutbox, processedEvents } from '@openora/core/server';
import {
  TagKeySchema,
  playerTagSchema,
  tagRuleSchema,
  tagSchema,
  type TagKey,
} from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { playerTag, tag, tagRule } from '@openora/core/pam/schema/tag';
import { walletTransaction } from '@openora/core/wallet/schema';
import { registerAndMaterializePlayer, screenedWithdrawalStatus, newStaff } from '../index.js';
import {
  autoWithdrawalPlugin,
  bootWalletE2e,
  closeWalletE2e,
  deliverWebhook,
  newDepositScenario,
  requestWithdrawalId,
  saveMaturedWithdrawalAddress,
  transactionById,
  waitForAudit,
  type WalletE2e,
} from './support/wallet.js';

let e2e: WalletE2e;

beforeAll(async () => {
  e2e = await bootWalletE2e([
    autoWithdrawalPlugin,
    {
      id: 'testing-withdrawal-adapter',
      path: fileURLToPath(new URL('./support/test-withdrawal-adapter-plugin.ts', import.meta.url)),
    },
  ]);
  const seeded = await e2e.admin.put('/wallet/auto-withdrawal-config', {
    fiatThreshold: '0',
    cryptoThreshold: '0',
    excludeRiskFlags: ['withdrawal_review'],
    velocityCount: null,
    velocityWindowHours: 24,
  });
  expect(seeded.status).toBe(200);
}, 60_000);

afterAll(() => closeWalletE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const FIXTURE_REASON = 'e2e tag fixture';
const CATALOG_PROBE_TAG = 'test_account' satisfies TagKey;

const TagListSchema = z.object({
  items: z.array(playerTagSchema.extend({ tag: z.object({ key: TagKeySchema }) })),
  total: z.number(),
});
const TagRuleListSchema = z.array(tagRuleSchema);
const AssignableTagsSchema = z.array(tagSchema);

const send = async (res: Response) => {
  const body: unknown = await res.json();
  return { status: res.status, body };
};

async function adminUserId() {
  const [row] = await db()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, 'admin@oss.dev'));
  if (!row) {
    throw new Error('seeded admin is missing');
  }
  return row.id;
}

const newTagPlayer = () =>
  registerAndMaterializePlayer(e2e.app, { email: `tag-${randomUUID()}@e2e.test` });

const assign = (playerId: string, tagKey: string, assignReason = FIXTURE_REASON) =>
  e2e.admin.post(`/player/${playerId}/player-tag`, { tagKey, assignReason, assignActor: 'manual' });

const remove = (playerId: string, tagKey: string, removalReason?: string) =>
  e2e.admin.request(`/player/${playerId}/player-tag/${tagKey}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      removalActor: 'manual',
      ...(removalReason === undefined ? {} : { removalReason }),
    }),
  });

const assignmentRows = (playerId: string, tagKey: TagKey) =>
  db()
    .select({
      id: playerTag.id,
      removedAt: playerTag.removedAt,
      removalReason: playerTag.removalReason,
      removalActor: playerTag.removalActor,
      removalActorUserId: playerTag.removalActorUserId,
      assignActor: playerTag.assignActor,
      assignActorUserId: playerTag.assignActorUserId,
      assignReason: playerTag.assignReason,
    })
    .from(playerTag)
    .innerJoin(tag, eq(tag.id, playerTag.tagId))
    .where(and(eq(playerTag.playerId, playerId), eq(tag.key, tagKey)));

const activeRows = async (playerId: string, tagKey: TagKey) =>
  (await assignmentRows(playerId, tagKey)).filter((row) => row.removedAt === null);

async function listedTags(playerId: string) {
  const res = await e2e.admin.get(`/player/${playerId}/player-tag`);
  expect(res.status).toBe(200);
  return TagListSchema.parse(await res.json());
}

async function assignableKeys(playerId: string) {
  const res = await e2e.admin.get(`/player/${playerId}/assignable-tags`);
  expect(res.status).toBe(200);
  return AssignableTagsSchema.parse(await res.json()).map((entry) => entry.key);
}

const catalogRows = (key: TagKey) => db().select().from(tag).where(eq(tag.key, key));

async function ensureInCatalog(key: TagKey, isSticky = true) {
  if ((await catalogRows(key)).length === 0) {
    const res = await e2e.admin.post('/tag', { key, isSticky });
    expect(res.status).toBe(200);
  }
}

async function readRule(tagKey: TagKey) {
  const res = await e2e.admin.get('/tag-rule');
  expect(res.status).toBe(200);
  const found = TagRuleListSchema.parse(await res.json()).find((rule) => rule.tagKey === tagKey);
  if (!found) {
    throw new Error(`no seeded rule for ${tagKey}`);
  }
  return found;
}

type RuleSettings = {
  isEnabled: boolean;
  threshold: string | null;
  thresholdDays: number | null;
  thresholdCount: number | null;
};

const putRule = (tagKey: string, settings: RuleSettings, client = e2e.admin) =>
  client.put(`/tag-rule/${tagKey}`, { tagKey, ...settings });

async function withRules<T>(
  entries: ReadonlyArray<readonly [TagKey, Partial<RuleSettings>]>,
  run: () => Promise<T>,
) {
  const before = new Map<TagKey, RuleSettings>();
  try {
    for (const [tagKey, patch] of entries) {
      const { isEnabled, threshold, thresholdDays, thresholdCount } = await readRule(tagKey);
      const original = { isEnabled, threshold, thresholdDays, thresholdCount };
      before.set(tagKey, original);
      const res = await putRule(tagKey, { ...original, ...patch });
      expect(res.status).toBe(200);
    }
    return await run();
  } finally {
    for (const [tagKey, original] of before) {
      await putRule(tagKey, original);
    }
  }
}

async function waitForTagEvaluation(userId: string, topic: string) {
  await vi.waitFor(
    async () => {
      const [emitted] = await db()
        .select({ n: sql<number>`count(*)::int` })
        .from(eventOutbox)
        .where(
          and(eq(eventOutbox.topic, topic), sql`${eventOutbox.payload}->>'userId' = ${userId}`),
        );
      const [handled] = await db()
        .select({ n: sql<number>`count(*)::int` })
        .from(processedEvents)
        .innerJoin(eventOutbox, eq(eventOutbox.eventId, processedEvents.eventId))
        .where(
          and(
            eq(eventOutbox.topic, topic),
            sql`${eventOutbox.payload}->>'userId' = ${userId}`,
            like(processedEvents.consumer, `%/tag/${topic}%`),
          ),
        );
      if (!emitted || emitted.n === 0 || emitted.n !== handled?.n) {
        throw new Error(`tag module has not handled ${topic} for ${userId} yet`);
      }
    },
    { timeout: 15_000, interval: 100 },
  );
}

async function depositor(amount: string) {
  const player = await newDepositScenario(e2e, { minDeposit: '1' });
  const deposit = async (value: string) => {
    const res = await deliverWebhook(e2e, player.deposit({ amount: value }));
    expect(res.status).toBe(200);
    await waitForTagEvaluation(player.userId, 'wallet.deposit.completed');
  };
  await deposit(amount);
  return { ...player, depositMore: deposit };
}

async function fundedPlayer(amount = '100') {
  const player = await newDepositScenario(e2e);
  const res = await deliverWebhook(e2e, player.deposit({ amount }));
  expect(res.status).toBe(200);
  const destinationAddress = await saveMaturedWithdrawalAddress(e2e, player, player.currency);
  const rule = await e2e.admin.put(`/wallet/auto-withdrawal-rules/${player.userId}`, {
    threshold: '1000',
    reason: 'e2e auto rule',
  });
  expect(rule.status).toBe(200);
  return { ...player, destinationAddress };
}

type FundedPlayer = Awaited<ReturnType<typeof fundedPlayer>>;

const withdraw = (player: FundedPlayer, amount: string) =>
  requestWithdrawalId(player.client, player, {
    amount,
    destinationAddress: player.destinationAddress,
  });

const forbiddenBody = (body: unknown) =>
  expect(body).toEqual(expect.objectContaining({ code: 'FORBIDDEN' }));

describe('tag lifecycle', () => {
  it('an admin creates a tag with a key and the tag is listed', async () => {
    const actor = await adminUserId();
    const holder = await newTagPlayer();
    const deleted = await e2e.admin.del(`/tag/${CATALOG_PROBE_TAG}`);
    expect(deleted.status).toBe(200);
    try {
      expect(await assignableKeys(holder.playerId)).not.toContain(CATALOG_PROBE_TAG);

      const created = await send(
        await e2e.admin.post('/tag', { key: CATALOG_PROBE_TAG, isSticky: true }),
      );

      expect(created.status).toBe(200);
      expect(created.body).toEqual(
        expect.objectContaining({ key: CATALOG_PROBE_TAG, isSticky: true }),
      );
      expect(await assignableKeys(holder.playerId)).toContain(CATALOG_PROBE_TAG);
      const [row] = await catalogRows(CATALOG_PROBE_TAG);
      expect(row?.isSticky).toBe(true);
      const audit = await waitForAudit(e2e, 'tag.created', CATALOG_PROBE_TAG);
      expect(audit.at(-1)).toEqual(
        expect.objectContaining({ actorType: 'admin', actorId: actor, resourceType: 'tag' }),
      );
    } finally {
      await ensureInCatalog(CATALOG_PROBE_TAG);
    }
  });

  it('creating a tag with an existing key is refused with a conflict', async () => {
    const before = await catalogRows('vip');

    const { status, body } = await send(
      await e2e.admin.post('/tag', { key: 'vip', isSticky: false }),
    );

    expect(status).toBe(409);
    expect(body).toEqual(expect.objectContaining({ code: 'CONFLICT' }));
    const after = await catalogRows('vip');
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.isSticky).toBe(true);
  });

  it('deleting an unused tag succeeds', async () => {
    const actor = await adminUserId();
    try {
      const { status, body } = await send(await e2e.admin.del(`/tag/${CATALOG_PROBE_TAG}`));

      expect(status).toBe(200);
      expect(body).toBe(true);
      expect(await catalogRows(CATALOG_PROBE_TAG)).toEqual([]);
      const rows = await waitForAudit(e2e, 'tag.deleted', CATALOG_PROBE_TAG);
      expect(rows.some((entry) => entry.actorId === actor && entry.actorType === 'admin')).toBe(
        true,
      );
      const again = await send(await e2e.admin.del(`/tag/${CATALOG_PROBE_TAG}`));
      expect(again.status).toBe(404);
    } finally {
      await ensureInCatalog(CATALOG_PROBE_TAG);
    }
  });

  it('deleting a tag that is assigned to a player is refused as in use', async () => {
    const holder = await newTagPlayer();
    expect((await assign(holder.playerId, 'age_verification_review')).status).toBe(200);

    const { status, body } = await send(await e2e.admin.del('/tag/age_verification_review'));

    expect(status).toBe(409);
    expect(body).toEqual(expect.objectContaining({ code: 'CONFLICT' }));
    expect(await catalogRows('age_verification_review')).toHaveLength(1);
    expect(await activeRows(holder.playerId, 'age_verification_review')).toHaveLength(1);
  });

  it('an admin without the permission cannot create or delete a tag', async () => {
    const staff = await newStaff(e2e.app, 'tag-lifecycle', 'admin');
    await ensureInCatalog(CATALOG_PROBE_TAG);
    const [before] = await catalogRows(CATALOG_PROBE_TAG);

    const create = await send(
      await staff.client.post('/tag', { key: CATALOG_PROBE_TAG, isSticky: false }),
    );
    const remove = await send(await staff.client.del(`/tag/${CATALOG_PROBE_TAG}`));

    expect(create.status).toBe(403);
    forbiddenBody(create.body);
    expect(remove.status).toBe(403);
    forbiddenBody(remove.body);
    const after = await catalogRows(CATALOG_PROBE_TAG);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before?.id);
    expect(after[0]?.isSticky).toBe(before?.isSticky);
  });
});

describe('manual assignment', () => {
  it('an admin assigns a tag to a player and the player tag list shows it as active', async () => {
    const actor = await adminUserId();
    const holder = await newTagPlayer();

    const { status, body } = await send(
      await assign(holder.playerId, 'vip', 'long standing player'),
    );

    expect(status).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({
        playerId: holder.playerId,
        tag: { key: 'vip' },
        assignReason: 'long standing player',
        assignActor: 'manual',
        assignActorUserId: actor,
        removedAt: null,
      }),
    );
    const listed = await listedTags(holder.playerId);
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toEqual(
      expect.objectContaining({ tag: { key: 'vip' }, assignActorUserId: actor, removedAt: null }),
    );
    const audit = await waitForAudit(e2e, 'tag.player.assigned', holder.playerId);
    expect(audit).toEqual([
      expect.objectContaining({
        actorId: actor,
        actorType: 'admin',
        after: { tagKey: 'vip', reason: 'long standing player' },
      }),
    ]);
  });

  it('assigning a tag the player already holds is reported as already active and adds no second row', async () => {
    const holder = await newTagPlayer();
    expect((await assign(holder.playerId, 'vip')).status).toBe(200);

    const again = await send(await assign(holder.playerId, 'vip', 'second attempt'));

    expect(again.status).toBe(409);
    expect(again.body).toEqual(expect.objectContaining({ code: 'CONFLICT' }));
    expect(await assignmentRows(holder.playerId, 'vip')).toHaveLength(1);
    expect((await listedTags(holder.playerId)).total).toBe(1);
    const audit = await waitForAudit(e2e, 'tag.player.assigned', holder.playerId);
    expect(audit).toHaveLength(1);
  });

  it('two parallel assignments of the same tag leave one active assignment', async () => {
    const holder = await newTagPlayer();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => assign(holder.playerId, 'multi_account')),
    );

    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409]);
    expect(await assignmentRows(holder.playerId, 'multi_account')).toHaveLength(1);
    expect(await activeRows(holder.playerId, 'multi_account')).toHaveLength(1);
  });

  it.todo(
    'BUG: assigning to an unknown player returns not found (tag.service.ts:361 assignPlayerTag stores an orphan assignment with no player lookup, the route answers 200)',
  );

  it.todo(
    'GAP: assigning a tag the player is not eligible for is refused (tag.service.ts:361 the manual route skips the check, only the agent path at :666 enforces it and no HTTP route reaches it)',
  );

  it('an admin lists the tags assignable to a player without the ones already held', async () => {
    const holder = await newTagPlayer();
    const before = await assignableKeys(holder.playerId);
    expect(before).toEqual(expect.arrayContaining(['vip', 'high_risk']));
    expect((await assign(holder.playerId, 'vip')).status).toBe(200);

    const after = await assignableKeys(holder.playerId);

    expect(after).not.toContain('vip');
    expect(after).toContain('high_risk');
    expect(after).toHaveLength(before.length - 1);
    expect(await assignableKeys((await newTagPlayer()).playerId)).toContain('vip');
  });

  it('removal requires a reason and an empty reason is refused', async () => {
    const holder = await newTagPlayer();
    expect((await assign(holder.playerId, 'vip')).status).toBe(200);

    const missing = await send(await remove(holder.playerId, 'vip'));
    const empty = await send(await remove(holder.playerId, 'vip', ''));
    const blank = await send(await remove(holder.playerId, 'vip', '      '));

    expect(missing.status).toBe(400);
    expect(missing.body).toEqual(expect.objectContaining({ code: 'BAD_REQUEST' }));
    expect(empty.status).toBe(400);
    expect(blank.status).toBe(400);
    expect(await activeRows(holder.playerId, 'vip')).toHaveLength(1);
    const accepted = await remove(holder.playerId, 'vip', 'verified by the vip team');
    expect(accepted.status).toBe(200);
    expect(await activeRows(holder.playerId, 'vip')).toHaveLength(0);
  });

  it('removing a tag marks the assignment removed and keeps the history row', async () => {
    const actor = await adminUserId();
    const holder = await newTagPlayer();
    expect((await assign(holder.playerId, 'vip')).status).toBe(200);

    const { status, body } = await send(await remove(holder.playerId, 'vip', 'no longer a vip'));

    expect(status).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({
        tag: { key: 'vip' },
        removalReason: 'no longer a vip',
        removalActor: 'manual',
        removalActorUserId: actor,
      }),
    );
    const rows = await assignmentRows(holder.playerId, 'vip');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        removalReason: 'no longer a vip',
        removalActor: 'manual',
        removalActorUserId: actor,
        assignReason: FIXTURE_REASON,
      }),
    );
    expect(rows[0]?.removedAt).toBeInstanceOf(Date);
    expect((await listedTags(holder.playerId)).total).toBe(0);
    expect(await assignableKeys(holder.playerId)).toContain('vip');
    const audit = await waitForAudit(e2e, 'tag.player.removed', holder.playerId);
    expect(audit).toEqual([
      expect.objectContaining({
        actorId: actor,
        actorType: 'admin',
        after: { tagKey: 'vip', reason: 'no longer a vip' },
      }),
    ]);
  });

  it('removing a tag the player does not hold returns not found', async () => {
    const holder = await newTagPlayer();
    const other = await newTagPlayer();
    expect((await assign(other.playerId, 'vip')).status).toBe(200);

    const { status, body } = await send(await remove(holder.playerId, 'vip', 'nothing to remove'));

    expect(status).toBe(404);
    expect(body).toEqual(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(await activeRows(other.playerId, 'vip')).toHaveLength(1);
    expect(await assignmentRows(holder.playerId, 'vip')).toEqual([]);
  });
});

describe('automatic tags', () => {
  it('a player crossing a rule threshold receives the automatic tag after the evaluation event', async () => {
    await withRules([['large_depositor', { isEnabled: true, threshold: '50' }]], async () => {
      const big = await depositor('200');
      const small = await depositor('10');

      await vi.waitFor(async () =>
        expect(await activeRows(big.playerId, 'large_depositor')).toHaveLength(1),
      );
      const [row] = await activeRows(big.playerId, 'large_depositor');
      expect(row).toEqual(
        expect.objectContaining({
          assignActor: 'scheduled',
          assignActorUserId: SYSTEM_ACTOR_ID,
          assignReason: 'single deposit crossed threshold',
        }),
      );
      expect(await assignmentRows(small.playerId, 'large_depositor')).toEqual([]);
      const audit = await waitForAudit(e2e, 'tag.player.assigned', big.playerId);
      expect(audit).toEqual([
        expect.objectContaining({
          actorType: 'system',
          actorId: SYSTEM_ACTOR_ID,
          after: { tagKey: 'large_depositor', reason: 'single deposit crossed threshold' },
        }),
      ]);
    });
  });

  it('a player falling back under the threshold loses a non sticky automatic tag', async () => {
    await withRules([['high_roller', { isEnabled: true, threshold: '100' }]], async () => {
      const player = await depositor('200');
      await vi.waitFor(async () =>
        expect(await activeRows(player.playerId, 'high_roller')).toHaveLength(1),
      );

      await putRule('high_roller', {
        isEnabled: true,
        threshold: '1000000',
        thresholdDays: null,
        thresholdCount: null,
      });
      await player.depositMore('1');

      await vi.waitFor(async () =>
        expect(await activeRows(player.playerId, 'high_roller')).toHaveLength(0),
      );
      const rows = await assignmentRows(player.playerId, 'high_roller');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          removalActor: 'scheduled',
          removalActorUserId: SYSTEM_ACTOR_ID,
          removalReason: 'lifetime deposits below threshold',
        }),
      );
    });
  });

  it('a sticky tag stays after the player falls back under the threshold', async () => {
    await withRules([['withdrawal_review', { isEnabled: true, threshold: '50' }]], async () => {
      const player = await fundedPlayer('200');
      const flagged = await withdraw(player, '60');
      await screenedWithdrawalStatus(e2e.app, flagged);
      expect(await activeRows(player.playerId, 'withdrawal_review')).toHaveLength(1);

      await putRule('withdrawal_review', {
        isEnabled: true,
        threshold: '1000',
        thresholdDays: null,
        thresholdCount: null,
      });
      const small = await withdraw(player, '10');
      await screenedWithdrawalStatus(e2e.app, small);

      const rows = await assignmentRows(player.playerId, 'withdrawal_review');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.removedAt).toBeNull();
      expect((await listedTags(player.playerId)).items.map((item) => item.tag.key)).toContain(
        'withdrawal_review',
      );
    });
  });

  it.todo(
    'GAP: a manually removed automatic tag is not re-applied by the next evaluation (tag-evaluation.service.ts:105 assigns again, nothing records a manual removal)',
  );

  it('a disabled rule applies no tag', async () => {
    await withRules(
      [
        ['large_depositor', { isEnabled: false, threshold: '5' }],
        ['high_roller', { isEnabled: true, threshold: '5' }],
      ],
      async () => {
        const player = await depositor('200');

        await vi.waitFor(async () =>
          expect(await activeRows(player.playerId, 'high_roller')).toHaveLength(1),
        );
        expect(await assignmentRows(player.playerId, 'large_depositor')).toEqual([]);
      },
    );
  });

  it('an admin updates a rule threshold and the next evaluation uses it', async () => {
    await withRules(
      [
        ['large_depositor', { isEnabled: true, threshold: '100000' }],
        ['high_roller', { isEnabled: true, threshold: '5' }],
      ],
      async () => {
        const player = await depositor('20');
        await vi.waitFor(async () =>
          expect(await activeRows(player.playerId, 'high_roller')).toHaveLength(1),
        );
        expect(await assignmentRows(player.playerId, 'large_depositor')).toEqual([]);

        const updated = await send(
          await putRule('large_depositor', {
            isEnabled: true,
            threshold: '15',
            thresholdDays: null,
            thresholdCount: null,
          }),
        );
        await player.depositMore('20');

        expect(updated.status).toBe(200);
        expect(updated.body).toEqual(
          expect.objectContaining({
            tagKey: 'large_depositor',
            isEnabled: true,
            threshold: '15.00',
          }),
        );
        expect((await readRule('large_depositor')).threshold).toBe('15.00');
        await vi.waitFor(async () =>
          expect(await activeRows(player.playerId, 'large_depositor')).toHaveLength(1),
        );
      },
    );
  });

  it('a rule for an unknown tag key is refused', async () => {
    const rulesBefore = await db().select().from(tagRule);
    const settings = {
      isEnabled: true,
      threshold: '10',
      thresholdDays: null,
      thresholdCount: null,
    };
    await e2e.admin.del(`/tag/${CATALOG_PROBE_TAG}`);
    try {
      const invalidKey = await send(await putRule('not_a_real_tag', settings));
      const uncatalogued = await send(await putRule(CATALOG_PROBE_TAG, settings));

      expect(invalidKey.status).toBe(400);
      expect(uncatalogued.status).toBe(404);
      expect(uncatalogued.body).toEqual(expect.objectContaining({ code: 'NOT_FOUND' }));
      expect(await db().select().from(tagRule)).toHaveLength(rulesBefore.length);
    } finally {
      await ensureInCatalog(CATALOG_PROBE_TAG);
    }
  });

  it('updating a rule without the permission is refused with forbidden', async () => {
    const staff = await newStaff(e2e.app, 'tag-rule', 'admin');
    const before = await readRule('large_depositor');

    const { status, body } = await send(
      await putRule(
        'large_depositor',
        { isEnabled: true, threshold: '1', thresholdDays: null, thresholdCount: null },
        staff.client,
      ),
    );

    expect(status).toBe(403);
    forbiddenBody(body);
    const after = await readRule('large_depositor');
    expect(after.isEnabled).toBe(before.isEnabled);
    expect(after.threshold).toBe(before.threshold);
  });
});

describe('tag that excludes automatic withdrawal', () => {
  it('a player holding the excluding tag has an eligible withdrawal routed to manual review', async () => {
    const player = await fundedPlayer();
    expect((await assign(player.playerId, 'withdrawal_review')).status).toBe(200);

    const id = await withdraw(player, '30');

    expect(await screenedWithdrawalStatus(e2e.app, id)).toBe('pending');
    expect(await transactionById(e2e, id)).toEqual(
      expect.objectContaining({ type: 'withdrawal', status: 'pending', direction: 'debit' }),
    );
    const rows = await db()
      .select({ status: walletTransaction.status })
      .from(walletTransaction)
      .where(eq(walletTransaction.id, id));
    expect(rows).toEqual([{ status: 'pending' }]);
  });

  it('removing the tag lets the next eligible withdrawal be paid automatically', async () => {
    const player = await fundedPlayer();
    expect((await assign(player.playerId, 'withdrawal_review')).status).toBe(200);
    const held = await withdraw(player, '20');
    expect(await screenedWithdrawalStatus(e2e.app, held)).toBe('pending');

    expect((await remove(player.playerId, 'withdrawal_review', 'review finished')).status).toBe(
      200,
    );
    const next = await withdraw(player, '20');

    expect(await screenedWithdrawalStatus(e2e.app, next)).toBe('completed');
    expect((await transactionById(e2e, held))?.status).toBe('pending');
  });

  it('a player without the tag is not affected', async () => {
    const tagged = await fundedPlayer();
    const clean = await fundedPlayer();
    expect((await assign(tagged.playerId, 'withdrawal_review')).status).toBe(200);

    const id = await withdraw(clean, '30');

    expect(await screenedWithdrawalStatus(e2e.app, id)).toBe('completed');
    expect(await activeRows(clean.playerId, 'withdrawal_review')).toEqual([]);
  });
});
