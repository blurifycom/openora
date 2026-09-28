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
import { createMcpKernel, createTestDb, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeAuditWriter } from '../../../testing/mock.js';
import { migrate as migratePlayerNote } from '../migrate.js';
import { playerNote } from '../schema/index.js';
import { PlayerNoteService, PlayerNotFoundError } from '../service/player-note.service.js';
import playerNotePlugin from '../plugin.js';

const ADMIN_ID = randomUUID();

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
    expect(rows[0]).toMatchObject({ actorId: ADMIN_ID, content: proposal.content });
    expect(result).toMatchObject({ status: 'created', note: { id: rows[0]!.id } });
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

  it('refuses an unknown player and writes neither a note nor an audit record', async () => {
    const { svc, audit } = makeService();
    const proposal = proposalFor(randomUUID());

    await expect(svc.createForProposal(proposal)).rejects.toBeInstanceOf(PlayerNotFoundError);

    expect(await notesOf(proposal.playerId)).toHaveLength(0);
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('rolls the note back when its audit record cannot be written', async () => {
    const { svc, audit } = makeService();
    audit.recordInTransaction.mockRejectedValueOnce(new Error('audit store unavailable'));
    const target = await seedPlayer();

    await expect(svc.createForProposal(proposalFor(target.id))).rejects.toThrow(
      'audit store unavailable',
    );

    expect(await notesOf(target.id)).toHaveLength(0);
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
