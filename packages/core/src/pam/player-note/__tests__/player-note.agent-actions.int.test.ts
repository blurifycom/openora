import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  Container,
  ModuleRegistryImpl,
  DRIZZLE,
  type CoreTokenCatalog,
} from '@openora/core/server';
import {
  AUDIT_WRITER,
  type ActionExecutionContext,
  type RunContext,
} from '@openora/core/contracts';
import {
  createMcpKernel,
  createTestDb,
  waitForRowLockWaiter,
  type TestDb,
} from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeAuditWriter } from '../../../testing/mock.js';
import { migrate as migratePlayerNote } from '../migrate.js';
import { playerNote } from '../schema/index.js';
import { PlayerNoteService, PlayerNotFoundError } from '../service/player-note.service.js';
import playerNotePlugin from '../plugin.js';

const ADMIN_ID = randomUUID();
const REVIEWED = 'Reviewed, no issues.';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migratePlayerNote, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${playerNote}, ${player} RESTART IDENTITY CASCADE`);
});

async function seedPlayer() {
  const [row] = await db.drizzle.db.insert(player).values({ userId: randomUUID() }).returning();
  return row!;
}

function notesOf(playerId: string) {
  return db.drizzle.db.select().from(playerNote).where(eq(playerNote.playerId, playerId));
}

function makeService() {
  const audit = makeAuditWriter();
  return { svc: new PlayerNoteService(db.drizzle, audit), audit };
}

const proposalFor = (playerId: string, content = 'Player asked about a delayed withdrawal.') => ({
  playerId,
  content,
  actorId: ADMIN_ID,
  proposalId: randomUUID(),
});

function bootKernel() {
  const audit = makeAuditWriter();
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(AUDIT_WRITER, () => audit);
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  playerNotePlugin.register(registry);
  const kernel = createMcpKernel({
    tools: registry.mcp.getTools(),
    actions: registry.actions.getAll(),
    container,
    authorize: async () => 'allowed',
    audit,
  });
  return { kernel, audit };
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

describe('PlayerNoteService.playerExists (real PG)', () => {
  it('is true for a player row and false for an unknown id', async () => {
    const { svc } = makeService();
    const target = await seedPlayer();

    expect(await svc.playerExists(target.id)).toBe(true);
    expect(await svc.playerExists(randomUUID())).toBe(false);
  });
});

describe('PlayerNoteService.createForProposal (real PG)', () => {
  it('writes the note and records it in the audit log on the same transaction', async () => {
    const { svc, audit } = makeService();
    const target = await seedPlayer();
    const proposal = proposalFor(target.id);

    const result = await svc.createForProposal(proposal);

    const rows = await notesOf(target.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: ADMIN_ID,
      content: proposal.content,
      proposalId: proposal.proposalId,
    });
    expect(result).toMatchObject({ status: 'created', note: { id: rows[0]!.id } });
    expect(result).not.toHaveProperty('note.proposalId');
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(audit.recordInTransaction).toHaveBeenCalledWith(expect.anything(), {
      actorId: ADMIN_ID,
      actorType: 'admin',
      action: 'admin.player_note.created',
      resourceType: 'player',
      resourceId: target.id,
      after: { noteId: rows[0]!.id, content: proposal.content, proposalId: proposal.proposalId },
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers a replay of the same proposal with already_created and writes nothing more', async () => {
    const { svc, audit } = makeService();
    const target = await seedPlayer();
    const proposal = proposalFor(target.id);

    await svc.createForProposal(proposal);
    const replay = await svc.createForProposal(proposal);

    expect(replay).toEqual({ status: 'already_created' });
    expect(await notesOf(target.id)).toHaveLength(1);
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
  });

  it('writes a note for each of two proposals carrying the same text from the same admin', async () => {
    const { svc, audit } = makeService();
    const target = await seedPlayer();
    const first = proposalFor(target.id, REVIEWED);
    const second = proposalFor(target.id, REVIEWED);

    const results = [await svc.createForProposal(first), await svc.createForProposal(second)];

    expect(results.map((r) => r.status)).toEqual(['created', 'created']);
    const rows = await notesOf(target.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.proposalId)).toEqual(
      expect.arrayContaining([first.proposalId, second.proposalId]),
    );
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(2);
  });

  it('adds the proposal note beside an identical note the same admin wrote by hand', async () => {
    const { svc } = makeService();
    const target = await seedPlayer();
    const proposal = proposalFor(target.id, REVIEWED);
    await svc.create({ playerId: target.id, content: REVIEWED }, ADMIN_ID);

    const result = await svc.createForProposal(proposal);

    expect(result).toMatchObject({ status: 'created' });
    const rows = await notesOf(target.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.proposalId)).toEqual(
      expect.arrayContaining([null, proposal.proposalId]),
    );
  });

  it('writes exactly one note when the same proposal executes twice concurrently', async () => {
    const { svc, audit } = makeService();
    const target = await seedPlayer();
    const proposal = proposalFor(target.id);

    const results = await Promise.all([
      svc.createForProposal(proposal),
      svc.createForProposal(proposal),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(['already_created', 'created']);
    expect(await notesOf(target.id)).toHaveLength(1);
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
  });

  it('waits out an uncommitted execution of the same proposal, then writes nothing', async () => {
    const { svc, audit } = makeService();
    const target = await seedPlayer();
    const proposal = proposalFor(target.id);

    const { racing } = await db.drizzle.db.transaction(async (tx) => {
      await tx.insert(playerNote).values(proposal);
      const pending = svc.createForProposal(proposal);
      await waitForRowLockWaiter(db);
      return { racing: pending };
    });

    expect(await racing).toEqual({ status: 'already_created' });
    expect(await notesOf(target.id)).toHaveLength(1);
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('refuses an unknown player and writes neither a note nor an audit record', async () => {
    const { svc, audit } = makeService();
    const proposal = proposalFor(randomUUID());

    await expect(svc.createForProposal(proposal)).rejects.toBeInstanceOf(PlayerNotFoundError);

    expect(await notesOf(proposal.playerId)).toHaveLength(0);
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('rolls the note back when its audit record cannot be written, so a retry still applies it', async () => {
    const { svc, audit } = makeService();
    audit.recordInTransaction.mockRejectedValueOnce(new Error('audit store unavailable'));
    const target = await seedPlayer();
    const proposal = proposalFor(target.id);

    await expect(svc.createForProposal(proposal)).rejects.toThrow('audit store unavailable');

    expect(await notesOf(target.id)).toHaveLength(0);
    expect(await svc.createForProposal(proposal)).toMatchObject({ status: 'created' });
    expect(await notesOf(target.id)).toHaveLength(1);
  });
});

describe('add_note action type (plugin wiring through the MCP kernel)', () => {
  it('refuses the precondition with player_not_found for an unknown player', async () => {
    const { kernel } = bootKernel();

    const result = await kernel.checkPrecondition(
      'add_note',
      { playerId: randomUUID(), content: 'A note' },
      runContext(),
    );

    expect(result).toEqual({ ok: false, error: 'player_not_found' });
  });

  it('passes the precondition for an existing player', async () => {
    const { kernel } = bootKernel();
    const target = await seedPlayer();

    const result = await kernel.checkPrecondition(
      'add_note',
      { playerId: target.id, content: 'A note' },
      runContext(),
    );

    expect(result).toEqual({ ok: true });
  });

  it('rejects content that is blank once trimmed', async () => {
    const { kernel } = bootKernel();
    const target = await seedPlayer();

    const result = await kernel.checkPrecondition(
      'add_note',
      { playerId: target.id, content: '   ' },
      runContext(),
    );

    expect(result).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('adds the trimmed note in the name of the admin the agent acts for, once per proposal', async () => {
    const { kernel, audit } = bootKernel();
    const target = await seedPlayer();
    const execution = agentExecution();
    const payload = { playerId: target.id, content: '  Player asked to close the account.  ' };

    const first = await kernel.executeAction('add_note', payload, execution);
    const replay = await kernel.executeAction('add_note', payload, execution);

    const rows = await notesOf(target.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: ADMIN_ID,
      content: 'Player asked to close the account.',
      proposalId: execution.proposalId,
    });
    expect(first).toEqual({ ok: true, outcome: 'applied', detail: { noteId: rows[0]!.id } });
    expect(replay).toEqual({ ok: true, outcome: 'already_applied' });
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
  });

  it('fails execution with player_not_found for an unknown player', async () => {
    const { kernel } = bootKernel();
    const playerId = randomUUID();

    const result = await kernel.executeAction(
      'add_note',
      { playerId, content: 'A note' },
      agentExecution(),
    );

    expect(result).toEqual({ ok: false, error: 'player_not_found' });
    expect(await notesOf(playerId)).toHaveLength(0);
  });
});
