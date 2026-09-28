import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { Container } from '../../kernel/index.js';
import {
  createToken,
  createSealedToken,
  defineActionType,
  defineMcpTool,
  MoneyAmountSchema,
  PlayerStatusSchema,
  UuidSchema,
  type ActionTypeContract,
  type McpToolContract,
  type Token,
} from '@openora/core/contracts';
import { mock } from '../../../testing/mock.js';
import { ModuleRegistryImpl } from '../module-registry.js';

function newRegistry() {
  const container = new Container();
  return { container, reg: new ModuleRegistryImpl(container) };
}

describe('ModuleRegistryImpl', () => {
  it('provide() binds to the container (last-wins)', () => {
    const { container, reg } = newRegistry();
    const TOKEN = createToken<string>('svc');
    reg.provide(TOKEN, () => 'a');
    reg.provide(TOKEN, () => 'b');
    expect(container.get(TOKEN)).toBe('b');
  });

  it('provide() refuses to bind a sealed token', () => {
    const { reg } = newRegistry();
    const SEALED = createSealedToken<string>('rg-enforcement');
    expect(() => reg.provide(SEALED as unknown as Token<string>, () => 'x')).toThrow(
      /sealed token/i,
    );
  });

  it('provideSealed() binds a sealed token exactly once', () => {
    const { container, reg } = newRegistry();
    const SEALED = createSealedToken<string>('audit-log-writer');
    reg.provideSealed(SEALED, () => 'canonical');
    expect(container.get(SEALED)).toBe('canonical');
  });

  it('provideSealed() rejects a second bind of the same sealed token', () => {
    const { reg } = newRegistry();
    const SEALED = createSealedToken<string>('audit-log-writer');
    reg.provideSealed(SEALED, () => 'canonical');
    expect(() => reg.provideSealed(SEALED, () => 'overlay-attempt')).toThrow(/already bound/i);
  });

  it('routers.add() rejects a duplicate namespace', () => {
    const { reg } = newRegistry();
    reg.routers.add('wallet', () => ({}) as never);
    expect(() => reg.routers.add('wallet', () => ({}) as never)).toThrow(/already registered/);
  });

  it('events.on() accumulates handlers per event', () => {
    const { reg } = newRegistry();
    const h1 = () => {};
    const h2 = () => {};
    reg.events.on('wallet.deposit.completed', h1);
    reg.events.on('wallet.deposit.completed', h2);
    expect(reg.events.getAll().get('wallet.deposit.completed')).toEqual([h1, h2]);
  });
});

const validTool = defineMcpTool({
  id: 'player.summary',
  title: 'Player summary',
  description: 'Status and balance of one player',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'player', action: 'view' },
  inputSchema: z
    .object({
      playerId: UuidSchema,
      limit: z.coerce.number().int().min(1).max(50).default(10),
      status: PlayerStatusSchema.optional(),
      note: z.string().max(200).nullable().optional(),
      window: z.object({ from: z.iso.date(), to: z.iso.date() }).optional(),
      tags: z.array(z.string().max(32)).max(10).optional(),
    })
    .superRefine(() => undefined),
  outputSchema: z.object({
    playerId: UuidSchema,
    status: PlayerStatusSchema,
    email: z.string(),
    balance: MoneyAmountSchema,
    lastLoginAt: z.iso.datetime().nullable(),
  }),
  redact: { allow: ['playerId', 'status', 'balance', 'lastLoginAt'], personal: ['playerId'] },
  errors: ['player_not_found'],
});

const toolFactory = () => async () => ({
  playerId: randomUUID(),
  status: 'active' as const,
  email: 'player@example.com',
  balance: '10.00',
  lastLoginAt: null,
});

const validAction = defineActionType({
  id: 'hold_withdrawal',
  title: 'Hold a withdrawal',
  description: 'Puts a pending withdrawal on hold for manual review',
  schemaVersion: 1,
  iam: { resource: 'withdrawal', action: 'hold' },
  reversible: true,
  payloadSchema: z.object({ withdrawalId: UuidSchema, reason: z.string().min(1).max(500) }),
  errors: ['withdrawal_not_pending'],
});

const actionFactory = () => ({
  precondition: async () => ({ ok: true as const }),
  execute: async () => ({ outcome: 'applied' as const }),
});

const toolWith = (overrides: object) => mock<McpToolContract>({ ...validTool, ...overrides });
const actionWith = (overrides: object) =>
  mock<ActionTypeContract>({ ...validAction, ...overrides });

describe('ModuleRegistryImpl - MCP tools and action types', () => {
  it('registers a valid tool and action type without running their factories', () => {
    const { reg } = newRegistry();
    const tool = vi.fn(toolFactory);
    const action = vi.fn(actionFactory);

    reg.mcp.tool(validTool, tool);
    reg.actions.register(validAction, action);

    expect(reg.mcp.getTools()).toEqual([{ contract: validTool, owner: 'unknown', factory: tool }]);
    expect(reg.actions.getAll()).toEqual([
      { contract: validAction, owner: 'unknown', factory: action },
    ]);
    expect(tool).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it('attributes a registration to the plugin set as owner, and to unknown after it', () => {
    const { reg } = newRegistry();

    reg.setOwner('wallet');
    reg.actions.register(validAction, actionFactory);
    reg.setOwner(null);
    reg.mcp.tool(validTool, toolFactory);

    expect(reg.actions.getAll().map(({ owner }) => owner)).toEqual(['wallet']);
    expect(reg.mcp.getTools().map(({ owner }) => owner)).toEqual(['unknown']);
  });

  it('keeps the legacy untyped tool listed by getAll() and out of the kernel registry', () => {
    const { reg } = newRegistry();
    const legacy = {
      name: 'legacy_lookup',
      description: 'Legacy lookup',
      inputSchema: { type: 'object' },
      handler: () => 'ok',
    };

    reg.mcp.tool(legacy);

    expect(reg.mcp.getAll()).toEqual([legacy]);
    expect(reg.mcp.getTools()).toEqual([]);
  });

  it('names the tool, its plugin, the problem and the fix in a rejection', () => {
    const { reg } = newRegistry();
    reg.setOwner('players');

    expect(() =>
      reg.mcp.tool(toolWith({ inputSchema: z.object({ q: z.string() }) }), toolFactory),
    ).toThrow(
      '[mcp] tool "player.summary" (plugin "players"): inputSchema field "q" is a string without a maximum length - add .max(n); only an enum, a UUID or an ISO date, time or datetime may leave it out',
    );
  });

  it.each<[string, object, RegExp]>([
    [
      'a top-level discriminated union',
      {
        inputSchema: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('player'), playerId: UuidSchema }),
          z.object({ kind: z.literal('email'), email: z.email() }),
        ]),
      },
      /inputSchema must be a top-level z\.object, not union - models send numbers as strings when a tool input is a oneOf/,
    ],
    [
      'an optional top-level object',
      { inputSchema: z.object({ playerId: UuidSchema }).optional() },
      /inputSchema must be a top-level z\.object, not optional/,
    ],
    [
      'a transform',
      { inputSchema: z.object({ playerId: UuidSchema.transform((id) => id.toLowerCase()) }) },
      /inputSchema field "playerId" transforms its value/,
    ],
    [
      'an unbounded string',
      { inputSchema: z.object({ window: z.object({ label: z.string() }) }) },
      /inputSchema field "window\.label" is a string without a maximum length/,
    ],
    [
      'a string bounded only by a regex',
      { inputSchema: z.object({ code: z.string().regex(/^[a-z]+$/) }) },
      /inputSchema field "code" is a string without a maximum length/,
    ],
    [
      'an email without a maximum length',
      { inputSchema: z.object({ email: z.email() }) },
      /inputSchema field "email" is a string without a maximum length/,
    ],
    [
      'a number without an upper bound',
      { inputSchema: z.object({ limit: z.coerce.number().int().min(1) }) },
      /inputSchema field "limit" is a number without both a lower and an upper bound/,
    ],
    [
      'a number that is not coerced',
      { inputSchema: z.object({ limit: z.number().int().min(1).max(50) }) },
      /inputSchema field "limit" is a z\.number\(\) - use z\.coerce\.number\(\)/,
    ],
    [
      'a number inside an array that is not coerced',
      { inputSchema: z.object({ amounts: z.array(z.number().min(0).max(5)).max(3) }) },
      /inputSchema field "amounts\[\]" is a z\.number\(\)/,
    ],
    [
      'a z.record',
      { inputSchema: z.object({ filters: z.record(z.string().max(10), z.string().max(10)) }) },
      /inputSchema field "filters" is a free-form map/,
    ],
    [
      'an object that accepts undeclared keys',
      { inputSchema: z.looseObject({ playerId: UuidSchema }) },
      /inputSchema accepts undeclared keys/,
    ],
    [
      'an untyped field',
      { inputSchema: z.object({ blob: z.unknown() }) },
      /inputSchema field "blob" accepts any value/,
    ],
    [
      'an array without a maximum length',
      { inputSchema: z.object({ playerIds: z.array(UuidSchema) }) },
      /inputSchema field "playerIds" is an array without a maximum length/,
    ],
    [
      'a date in the input',
      { inputSchema: z.object({ since: z.date() }) },
      /inputSchema field "since" is a z\.date\(\)/,
    ],
    [
      'a date in the output',
      { outputSchema: z.object({ at: z.date() }), redact: { allow: ['at'] } },
      /outputSchema cannot be converted to JSON Schema \(Date cannot be represented/,
    ],
    [
      'an output that is not a top-level object',
      { outputSchema: z.array(z.string().max(5)).max(5) },
      /outputSchema must be a top-level z\.object, not array/,
    ],
    ['an empty allow-list', { redact: { allow: [] } }, /redact\.allow is empty/],
    [
      'an allow key the output schema does not declare',
      { redact: { allow: ['playerId', 'phone'] } },
      /redact\.allow key "phone" is not in outputSchema/,
    ],
    [
      'a personal key that is not allowed',
      { redact: { allow: ['status'], personal: ['playerId'] } },
      /redact\.personal key "playerId" is not in redact\.allow/,
    ],
    ['an uppercase id', { id: 'Player.summary' }, /id must match .* and be at most 64 characters/],
    ['an id with an empty segment', { id: 'player..summary' }, /id must match/],
    ['an id longer than 64 characters', { id: `player.${'a'.repeat(58)}` }, /id must match/],
    [
      'an IAM action the resource does not declare',
      { iam: { resource: 'player', action: 'approve' } },
      /iam\.action "approve" is not an action of "player" - use one of: view, update, ban/,
    ],
    [
      'an IAM resource outside the admin statement',
      { iam: { resource: 'tournament', action: 'view' } },
      /iam\.resource "tournament" is not in adminStatement/,
    ],
    ['a missing IAM requirement', { iam: undefined }, /iam is missing/],
    [
      'an error code reserved by the kernel',
      { errors: ['forbidden'] },
      /error code "forbidden" is reserved by the kernel/,
    ],
    [
      'a malformed error code',
      { errors: ['Player-Not-Found'] },
      /error code "Player-Not-Found" must match/,
    ],
    [
      'a duplicated error code',
      { errors: ['player_not_found', 'player_not_found'] },
      /declared twice/,
    ],
    ['a blank title', { title: '   ' }, /title must be 1\.\.80 characters/],
    [
      'an overlong description',
      { description: 'x'.repeat(1025) },
      /description must be 1\.\.1024 characters/,
    ],
    ['a zero schemaVersion', { schemaVersion: 0 }, /schemaVersion must be a positive integer/],
    ['an unknown class', { class: 'write' }, /class must be one of read, propose/],
  ])('rejects a tool with %s', (_label, overrides, message) => {
    const { reg } = newRegistry();

    expect(() => reg.mcp.tool(toolWith(overrides), toolFactory)).toThrow(message);
    expect(reg.mcp.getTools()).toEqual([]);
  });

  it('rejects a tool registered without a factory function', () => {
    const { reg } = newRegistry();

    expect(() => reg.mcp.tool(validTool, mock())).toThrow(/factory must be a function/);
  });

  it.each<[string, object, RegExp]>([
    [
      'no IAM requirement',
      { iam: undefined },
      /every action type must name the IAM resource its executor needs/,
    ],
    ['a dotted id', { id: 'wallet.hold' }, /id must match/],
    [
      'a reversible flag that is not a boolean',
      { reversible: 'yes' },
      /reversible must be a boolean/,
    ],
    [
      'a payload whose top level is a union',
      {
        payloadSchema: z.union([
          z.object({ withdrawalId: UuidSchema }),
          z.object({ playerId: UuidSchema }),
        ]),
      },
      /payloadSchema must be a top-level z\.object, not union/,
    ],
    [
      'a payload number that is not coerced',
      { payloadSchema: z.object({ amount: z.number().min(0).max(10) }) },
      /payloadSchema field "amount" is a z\.number\(\)/,
    ],
    [
      'an error code reserved by the kernel',
      { errors: ['internal_error'] },
      /error code "internal_error" is reserved by the kernel/,
    ],
  ])('rejects an action type with %s', (_label, overrides, message) => {
    const { reg } = newRegistry();

    expect(() => reg.actions.register(actionWith(overrides), actionFactory)).toThrow(message);
    expect(reg.actions.getAll()).toEqual([]);
  });

  it('rejects a tool id an action type already holds', () => {
    const { reg } = newRegistry();
    reg.setOwner('wallet');
    reg.actions.register(validAction, actionFactory);
    reg.setOwner('players');

    expect(() => reg.mcp.tool(toolWith({ id: 'hold_withdrawal' }), toolFactory)).toThrow(
      '[mcp] tool "hold_withdrawal" (plugin "players"): id is already registered as an action type of plugin "wallet"',
    );
  });

  it('rejects an action type id a tool already holds', () => {
    const { reg } = newRegistry();
    reg.mcp.tool(toolWith({ id: 'hold_withdrawal' }), toolFactory);

    expect(() => reg.actions.register(validAction, actionFactory)).toThrow(
      /action type "hold_withdrawal" .*id is already registered as a tool/,
    );
  });

  it('rejects a second tool whose model name collides with the first', () => {
    const { reg } = newRegistry();
    reg.mcp.tool(validTool, toolFactory);

    expect(() => reg.mcp.tool(toolWith({ id: 'player_summary' }), toolFactory)).toThrow(
      /model name "player_summary" collides with tool "player\.summary"/,
    );
  });
});
