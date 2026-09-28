import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DOMAIN_EVENT_CATALOG, getEventVersion } from '../../schemas/events.js';
import {
  McpToolError,
  RunContextSchema,
  runActorAdminId,
  triggerCatalog,
  type RunActor,
} from '../mcp.js';

const runFields = () => ({
  runId: randomUUID(),
  catalogVersion: 'catalog-1',
  correlationId: 'correlation-1',
});

describe('RunContextSchema', () => {
  it.each([
    ['an admin', { kind: 'admin', adminId: randomUUID() }],
    [
      'an agent acting for an admin',
      { kind: 'agent', agentId: randomUUID(), agentVersion: 2, onBehalfOf: randomUUID() },
    ],
    [
      'an MCP token owned by an admin',
      { kind: 'mcp_token', tokenId: randomUUID(), adminId: randomUUID() },
    ],
  ])('accepts %s as the actor', (_label, actor) => {
    expect(RunContextSchema.safeParse({ ...runFields(), actor }).success).toBe(true);
  });

  it('rejects an agent that does not name the admin it acts for', () => {
    const result = RunContextSchema.safeParse({
      ...runFields(),
      actor: { kind: 'agent', agentId: randomUUID(), agentVersion: 2 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['actor.onBehalfOf']);
  });
});

describe('runActorAdminId', () => {
  const adminId = randomUUID();

  it.each<[string, RunActor]>([
    ['the admin itself', { kind: 'admin', adminId }],
    [
      'the admin an agent acts for',
      { kind: 'agent', agentId: randomUUID(), agentVersion: 1, onBehalfOf: adminId },
    ],
    ["the token's owner", { kind: 'mcp_token', tokenId: randomUUID(), adminId }],
  ])('checks grants against %s', (_label, actor) => {
    expect(runActorAdminId(actor)).toBe(adminId);
  });
});

describe('McpToolError', () => {
  it('carries its code as the whole message', () => {
    const error = new McpToolError('player_not_found');

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'McpToolError',
      code: 'player_not_found',
      message: 'player_not_found',
    });
  });
});

describe('triggerCatalog', () => {
  it('lists every domain event once, at its current schema version', () => {
    const triggers = triggerCatalog();

    expect(triggers.map((trigger) => trigger.topic)).toEqual(DOMAIN_EVENT_CATALOG);
    for (const trigger of triggers) {
      expect(trigger).toMatchObject({
        kind: 'event',
        version: getEventVersion(trigger.topic),
        domain: trigger.topic.slice(0, trigger.topic.indexOf('.')),
        payloadJsonSchema: { $schema: 'http://json-schema.org/draft-07/schema#' },
      });
    }
  });

  it('carries a bumped event version and its payload shape', () => {
    const kycUpdated = triggerCatalog().find(
      (trigger) => trigger.topic === 'compliance.kyc.updated',
    );

    expect(kycUpdated).toMatchObject({
      domain: 'compliance',
      version: 6,
      payloadJsonSchema: { type: 'object', properties: { userId: { format: 'uuid' } } },
    });
  });

  it('builds the catalog once and serves it afterwards', () => {
    expect(triggerCatalog()).toBe(triggerCatalog());
  });
});
