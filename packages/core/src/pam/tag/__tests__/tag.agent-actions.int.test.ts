import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  Container,
  ModuleRegistryImpl,
  DRIZZLE,
  EVENT_BUS,
  type CoreTokenCatalog,
} from '@openora/core/server';
import {
  PLAY_ELIGIBILITY,
  type ActionExecutionContext,
  type PlayEligibilityPort,
  type PlayerStatus,
  type RunContext,
  type TagKey,
} from '@openora/core/contracts';
import { createMcpKernel, createTestDb, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeAuditWriter, makeEventBus, mock } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { playerTag, tag } from '../schema/index.js';
import {
  TagService,
  TagNotFoundError,
  PlayerNotFoundError,
  PlayerNotEligibleForTagError,
} from '../service/tag.service.js';
import tagPlugin from '../plugin.js';

const ADMIN_ID = randomUUID();
const REASON = 'Flagged by the account review agent';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${playerTag}, ${tag}, ${player} RESTART IDENTITY CASCADE`,
  );
});

async function seedTags(...keys: TagKey[]) {
  await db.drizzle.db.insert(tag).values(keys.map((key) => ({ key, isSticky: true })));
}

async function seedPlayer(status: PlayerStatus = 'active') {
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ userId: randomUUID(), status })
    .returning();
  return row!;
}

async function activeAssignments(playerId: string, tagKey: TagKey) {
  return db.drizzle.db
    .select({ row: playerTag })
    .from(playerTag)
    .innerJoin(tag, eq(tag.id, playerTag.tagId))
    .where(and(eq(playerTag.playerId, playerId), eq(tag.key, tagKey), isNull(playerTag.removedAt)));
}

function playEligibility(restricted = false) {
  const isRestricted = vi.fn(async (_userId: string) => restricted);
  return { port: mock<PlayEligibilityPort>({ isRestricted }), isRestricted };
}

function makeService({ restricted = false } = {}) {
  const events = makeEventBus();
  const eligibility = playEligibility(restricted);
  return {
    svc: new TagService(db.drizzle, events, eligibility.port),
    events,
    isRestricted: eligibility.isRestricted,
  };
}

const assignment = (playerId: string, tagKey: TagKey) => ({
  playerId,
  tagKey,
  assignReason: REASON,
  assignActor: 'manual' as const,
  assignActorUserId: ADMIN_ID,
});

describe('TagService.assignmentRefusal (real PG)', () => {
  it('refuses an unknown player', async () => {
    const { svc } = makeService();
    await seedTags('vip');

    expect(await svc.assignmentRefusal(randomUUID(), 'vip')).toBe('player_not_found');
  });

  it('refuses a tag missing from the catalog', async () => {
    const { svc } = makeService();
    const target = await seedPlayer();

    expect(await svc.assignmentRefusal(target.id, 'vip')).toBe('tag_not_found');
  });

  it('refuses a tag the player already holds', async () => {
    const { svc } = makeService();
    await seedTags('bonus_abuser');
    const target = await seedPlayer();
    await svc.assignPlayerTag(assignment(target.id, 'bonus_abuser'));

    expect(await svc.assignmentRefusal(target.id, 'bonus_abuser')).toBe('tag_already_active');
  });

  it.each(['active', 'dormant'] as const)('allows vip for a %s player', async (status) => {
    const { svc } = makeService();
    await seedTags('vip', 'self_excluded');
    const target = await seedPlayer(status);

    expect(await svc.assignmentRefusal(target.id, 'vip')).toBeNull();
  });

  it.each(['self_excluded', 'suspended', 'closed'] as const)(
    'refuses vip for a %s player',
    async (status) => {
      const { svc } = makeService();
      await seedTags('vip');
      const target = await seedPlayer(status);

      expect(await svc.assignmentRefusal(target.id, 'vip')).toBe('player_not_eligible');
    },
  );

  it('refuses vip for an active player carrying the self_excluded tag', async () => {
    const { svc } = makeService();
    await seedTags('vip', 'self_excluded');
    const target = await seedPlayer();
    await svc.assignPlayerTag(assignment(target.id, 'self_excluded'));

    expect(await svc.assignmentRefusal(target.id, 'vip')).toBe('player_not_eligible');
  });

  it('refuses vip for an active player whose RG restriction is in force', async () => {
    const { svc, isRestricted } = makeService({ restricted: true });
    await seedTags('vip', 'self_excluded');
    const target = await seedPlayer();

    expect(await svc.assignmentRefusal(target.id, 'vip')).toBe('player_not_eligible');
    expect(isRestricted).toHaveBeenCalledWith(target.userId);
  });

  it('applies the eligibility guard to vip only', async () => {
    const { svc } = makeService({ restricted: true });
    await seedTags('bonus_abuser');
    const target = await seedPlayer('self_excluded');

    expect(await svc.assignmentRefusal(target.id, 'bonus_abuser')).toBeNull();
  });
});

describe('TagService.assignPlayerTagForProposal (real PG)', () => {
  it('assigns the tag as a manual assignment by the admin and emits tag.player.assigned', async () => {
    const { svc, events } = makeService();
    await seedTags('high_risk');
    const target = await seedPlayer();

    const outcome = await svc.assignPlayerTagForProposal(assignment(target.id, 'high_risk'));

    expect(outcome.status).toBe('created');
    const rows = await activeAssignments(target.id, 'high_risk');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.row).toMatchObject({
      assignActor: 'manual',
      assignActorUserId: ADMIN_ID,
      assignReason: REASON,
    });
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith('tag.player.assigned', {
      playerId: target.id,
      tagKey: 'high_risk',
      reason: REASON,
      actorId: ADMIN_ID,
    });
  });

  it('answers a replay with already_active, leaving one active row and one event', async () => {
    const { svc, events } = makeService();
    await seedTags('multi_account');
    const target = await seedPlayer();

    await svc.assignPlayerTagForProposal(assignment(target.id, 'multi_account'));
    const replay = await svc.assignPlayerTagForProposal(assignment(target.id, 'multi_account'));

    expect(replay).toEqual({ status: 'already_active' });
    expect(await activeAssignments(target.id, 'multi_account')).toHaveLength(1);
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it('leaves one active row when the same proposal executes twice concurrently', async () => {
    const { svc, events } = makeService();
    await seedTags('bonus_abuser');
    const target = await seedPlayer();

    const outcomes = await Promise.all([
      svc.assignPlayerTagForProposal(assignment(target.id, 'bonus_abuser')),
      svc.assignPlayerTagForProposal(assignment(target.id, 'bonus_abuser')),
    ]);

    expect(outcomes.map((o) => o.status).sort()).toEqual(['already_active', 'created']);
    expect(await activeAssignments(target.id, 'bonus_abuser')).toHaveLength(1);
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it('re-checks vip eligibility at execution: a player self-excluded after the proposal is refused', async () => {
    const { svc, events } = makeService();
    await seedTags('vip');
    const target = await seedPlayer();
    expect(await svc.assignmentRefusal(target.id, 'vip')).toBeNull();
    await db.drizzle.db
      .update(player)
      .set({ status: 'self_excluded' })
      .where(eq(player.id, target.id));

    await expect(
      svc.assignPlayerTagForProposal(assignment(target.id, 'vip')),
    ).rejects.toBeInstanceOf(PlayerNotEligibleForTagError);

    expect(await activeAssignments(target.id, 'vip')).toHaveLength(0);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('refuses vip at execution for a player whose RG restriction is in force', async () => {
    const { svc } = makeService({ restricted: true });
    await seedTags('vip');
    const target = await seedPlayer();

    await expect(
      svc.assignPlayerTagForProposal(assignment(target.id, 'vip')),
    ).rejects.toBeInstanceOf(PlayerNotEligibleForTagError);
    expect(await activeAssignments(target.id, 'vip')).toHaveLength(0);
  });

  it('still answers already_active for an applied vip after the player became ineligible', async () => {
    const { svc } = makeService();
    await seedTags('vip');
    const target = await seedPlayer();
    await svc.assignPlayerTagForProposal(assignment(target.id, 'vip'));
    await db.drizzle.db.update(player).set({ status: 'closed' }).where(eq(player.id, target.id));

    const replay = await svc.assignPlayerTagForProposal(assignment(target.id, 'vip'));

    expect(replay).toEqual({ status: 'already_active' });
  });

  it('refuses an unknown player without writing a row', async () => {
    const { svc } = makeService();
    await seedTags('high_risk');
    const playerId = randomUUID();

    await expect(
      svc.assignPlayerTagForProposal(assignment(playerId, 'high_risk')),
    ).rejects.toBeInstanceOf(PlayerNotFoundError);
    expect(await activeAssignments(playerId, 'high_risk')).toHaveLength(0);
  });

  it('refuses a tag missing from the catalog', async () => {
    const { svc } = makeService();
    const target = await seedPlayer();

    await expect(
      svc.assignPlayerTagForProposal(assignment(target.id, 'high_risk')),
    ).rejects.toBeInstanceOf(TagNotFoundError);
  });
});

function bootKernel({ restricted = false } = {}) {
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => makeEventBus());
  container.register(PLAY_ELIGIBILITY, () => playEligibility(restricted).port);
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  tagPlugin.register(registry);
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
  actor: { kind: 'admin', adminId: ADMIN_ID },
  catalogVersion: 'test',
  correlationId: 'test',
});

const agentExecution = (): ActionExecutionContext => ({
  proposalId: randomUUID(),
  actor: { kind: 'agent', agentId: randomUUID(), agentVersion: 1, onBehalfOf: ADMIN_ID },
  correlationId: 'test',
});

describe('add_tag action type (plugin wiring through the MCP kernel)', () => {
  it('refuses the precondition with player_not_eligible for vip on a self-excluded player', async () => {
    const kernel = bootKernel();
    await seedTags('vip');
    const target = await seedPlayer('self_excluded');

    const result = await kernel.checkPrecondition(
      'add_tag',
      { playerId: target.id, tagKey: 'vip', reason: REASON },
      runContext(),
    );

    expect(result).toEqual({ ok: false, error: 'player_not_eligible' });
  });

  it('rejects a tag outside the agent-assignable set', async () => {
    const kernel = bootKernel();
    const target = await seedPlayer();

    const result = await kernel.checkPrecondition(
      'add_tag',
      { playerId: target.id, tagKey: 'withdrawal_review', reason: REASON },
      runContext(),
    );

    expect(result).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('applies the tag in the name of the admin the agent acts for, once per proposal', async () => {
    const kernel = bootKernel();
    await seedTags('vip');
    const target = await seedPlayer();
    const execution = agentExecution();
    const payload = { playerId: target.id, tagKey: 'vip', reason: `  ${REASON}  ` };

    const first = await kernel.executeAction('add_tag', payload, execution);
    const replay = await kernel.executeAction('add_tag', payload, execution);

    expect(first).toEqual({ ok: true, outcome: 'applied' });
    expect(replay).toEqual({ ok: true, outcome: 'already_applied' });
    const rows = await activeAssignments(target.id, 'vip');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.row).toMatchObject({ assignActorUserId: ADMIN_ID, assignReason: REASON });
  });

  it('fails execution with player_not_eligible for vip on an RG-restricted player', async () => {
    const kernel = bootKernel({ restricted: true });
    await seedTags('vip');
    const target = await seedPlayer();

    const result = await kernel.executeAction(
      'add_tag',
      { playerId: target.id, tagKey: 'vip', reason: REASON },
      agentExecution(),
    );

    expect(result).toEqual({ ok: false, error: 'player_not_eligible' });
    expect(await activeAssignments(target.id, 'vip')).toHaveLength(0);
  });
});

describe('send_to_manual_review action type (plugin wiring through the MCP kernel)', () => {
  it('assigns withdrawal_review once and then reports already_in_manual_review', async () => {
    const kernel = bootKernel();
    await seedTags('withdrawal_review');
    const target = await seedPlayer();
    const execution = agentExecution();
    const payload = { playerId: target.id, reason: REASON };

    const before = await kernel.checkPrecondition('send_to_manual_review', payload, runContext());
    const first = await kernel.executeAction('send_to_manual_review', payload, execution);
    const replay = await kernel.executeAction('send_to_manual_review', payload, execution);
    const after = await kernel.checkPrecondition('send_to_manual_review', payload, runContext());

    expect(before).toEqual({ ok: true });
    expect(first).toEqual({ ok: true, outcome: 'applied' });
    expect(replay).toEqual({ ok: true, outcome: 'already_applied' });
    expect(after).toEqual({ ok: false, error: 'already_in_manual_review' });
    const rows = await activeAssignments(target.id, 'withdrawal_review');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.row).toMatchObject({
      assignActor: 'manual',
      assignActorUserId: ADMIN_ID,
      assignReason: REASON,
    });
  });

  it('refuses the precondition with player_not_found for an unknown player', async () => {
    const kernel = bootKernel();
    await seedTags('withdrawal_review');

    const result = await kernel.checkPrecondition(
      'send_to_manual_review',
      { playerId: randomUUID(), reason: REASON },
      runContext(),
    );

    expect(result).toEqual({ ok: false, error: 'player_not_found' });
  });
});
