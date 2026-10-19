import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  DOMAIN_EVENT_CATALOG,
  domainEventSchemas,
  getEventVersion,
  type DomainEventName,
} from '../../schemas/events.js';
import {
  McpToolError,
  RunContextSchema,
  TRIGGER_SUBJECT_OVERRIDES,
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

describe('triggerCatalog subjectField', () => {
  const subjectOf = (topic: string) =>
    triggerCatalog().find((trigger) => trigger.topic === topic)?.subjectField;
  const payloadFields = (topic: DomainEventName): string[] => {
    const schema: z.ZodType = domainEventSchemas[topic];
    return schema instanceof z.ZodObject ? Object.keys(schema.shape) : [];
  };

  it.each([
    ['identity.user.login', 'userId'],
    ['identity.2fa.enabled', 'userId'],
    ['wallet.deposit.completed', 'userId'],
    ['wallet.withdrawal.approved', 'userId'],
    ['gaming.round.ended', 'userId'],
    ['rg.self_exclusion.activated', 'userId'],
    ['compliance.kyc.updated', 'userId'],
    ['player.status.changed', 'userId'],
    ['promo.bonus.granted', 'userId'],
    ['chat.room.member.joined', 'userId'],
    ['chat.room.member.left', 'userId'],
    ['chat.room.member.kicked', 'userId'],
    ['chat.room.member.banned', 'userId'],
    ['chat.room.member.role-changed', 'userId'],
    ['chat.user.blocked', 'playerId'],
    ['chat.user.ignored', 'playerId'],
    ['chat.room.invite.accepted', 'playerId'],
    ['tag.player.assigned', 'playerId'],
    ['chat.room.invite.sent', null],
    ['chat.room.invite.withheld', null],
    ['iam.role.assigned', null],
    ['identity.2fa.enrollment_blocked', null],
    ['player.account.closed', null],
    ['identity.user.deactivated', null],
    ['social.friend_request.sent', null],
    ['gaming.games.bulk_updated', null],
  ])('reads %s as about %s', (topic, subject) => {
    expect(subjectOf(topic)).toBe(subject);
  });

  it('takes the user wherever a payload names both a user and a player, unless listed', () => {
    const both = DOMAIN_EVENT_CATALOG.filter(
      (topic) =>
        !(topic in TRIGGER_SUBJECT_OVERRIDES) &&
        payloadFields(topic).includes('userId') &&
        payloadFields(topic).includes('playerId'),
    );

    expect(both.length).toBeGreaterThan(60);
    expect(both.filter((topic) => subjectOf(topic) !== 'userId')).toEqual([]);
  });

  it('names only a field the payload has', () => {
    for (const trigger of triggerCatalog()) {
      if (trigger.subjectField !== null) {
        expect(payloadFields(trigger.topic)).toContain(trigger.subjectField);
      }
    }
  });

  it('lists only catalogued topics among its exceptions, and applies each', () => {
    for (const [topic, subject] of Object.entries(TRIGGER_SUBJECT_OVERRIDES)) {
      expect(DOMAIN_EVENT_CATALOG).toContain(topic);
      expect(subjectOf(topic)).toBe(subject);
    }
  });
});
