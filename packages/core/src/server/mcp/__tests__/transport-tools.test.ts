import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  CORRELATION_ID_META_KEY,
  exposedTools,
  projectOutput,
  toCallToolResult,
} from '../transport-tools.js';
import { transportKernel } from './fixtures/transport-kernel.js';

const descriptors = () => transportKernel().kernel.listTools();

const correlationId = randomUUID();

function textOf(result: CallToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') {
    throw new Error('expected a text block');
  }
  return JSON.parse(block.text);
}

describe('exposedTools', () => {
  it('serves only read-class tools, under their model names, marked read-only', () => {
    const tools = exposedTools(descriptors(), 'drop');

    expect(tools.map((tool) => tool.definition.name)).toEqual(['player_summary']);
    expect(tools[0]).toMatchObject({
      id: 'player.summary',
      iam: { resource: 'player', action: 'view' },
      definition: {
        title: 'Player summary',
        description: 'Status and balance of one player',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    });
  });

  it('publishes the input schema as a JSON object schema', () => {
    const [tool] = exposedTools(descriptors(), 'drop');

    expect(tool.definition.inputSchema).toMatchObject({
      type: 'object',
      properties: { playerId: { type: 'string' } },
      required: ['playerId'],
    });
  });

  it('drops the personal keys from the exposed keys and the published output schema', () => {
    const [tool] = exposedTools(descriptors(), 'drop');

    expect(tool.keys).toEqual(['playerId', 'status', 'balance', 'note']);
    expect(Object.keys(tool.definition.outputSchema?.properties ?? {})).toEqual([
      'playerId',
      'status',
      'balance',
      'note',
    ]);
    expect(tool.definition.outputSchema?.required).toEqual(['playerId', 'status', 'balance']);
  });

  it('keeps the personal keys in include mode and still never a key the tool does not allow', () => {
    const [tool] = exposedTools(descriptors(), 'include');

    expect(tool.keys).toEqual(['playerId', 'email', 'status', 'balance', 'note']);
    expect(Object.keys(tool.definition.outputSchema?.properties ?? {})).toEqual([
      'playerId',
      'email',
      'status',
      'balance',
      'note',
    ]);
    expect(tool.definition.outputSchema?.required).toEqual([
      'playerId',
      'email',
      'status',
      'balance',
    ]);
  });

  it('publishes the kernel output schema itself, narrowed by the personal keys in drop mode', () => {
    const [summary] = descriptors().filter((descriptor) => descriptor.class === 'read');
    const outputJsonSchema = {
      type: 'object',
      title: 'Published by the kernel',
      properties: { playerId: { type: 'string' }, email: { type: 'string' } },
      required: ['playerId', 'email'],
      additionalProperties: false,
    };

    const [dropped] = exposedTools([{ ...summary, outputJsonSchema }], 'drop');
    const [included] = exposedTools([{ ...summary, outputJsonSchema }], 'include');

    expect(dropped.definition.outputSchema).toEqual({
      type: 'object',
      title: 'Published by the kernel',
      properties: { playerId: { type: 'string' } },
      required: ['playerId'],
      additionalProperties: false,
    });
    expect(included.definition.outputSchema).toEqual(outputJsonSchema);
  });

  it('refuses at boot a tool whose input schema is not a JSON object schema', () => {
    const [summary] = descriptors().filter((descriptor) => descriptor.class === 'read');

    expect(() =>
      exposedTools([{ ...summary, inputJsonSchema: { type: 'string' } }], 'drop'),
    ).toThrow(/"player\.summary": its input JSON Schema is not an object schema/);
  });

  it('refuses at boot a tool whose output schema is not a JSON object schema', () => {
    const [summary] = descriptors().filter((descriptor) => descriptor.class === 'read');

    expect(() =>
      exposedTools([{ ...summary, outputJsonSchema: { type: 'array' } }], 'drop'),
    ).toThrow(/"player\.summary": its output JSON Schema is not an object schema/);
  });
});

describe('projectOutput', () => {
  it('keeps only the listed keys that carry a value', () => {
    expect(
      projectOutput({ playerId: 'p-1', email: 'e', note: undefined, extra: 1 }, [
        'playerId',
        'note',
        'absent',
      ]),
    ).toEqual({ playerId: 'p-1' });
  });

  it('never reads a listed key off the prototype', () => {
    expect(projectOutput({}, ['constructor', 'toString'])).toEqual({});
  });
});

describe('toCallToolResult', () => {
  it('returns the projected output as structured content and as the same JSON text', () => {
    const result = toCallToolResult(
      { ok: true, output: { playerId: 'p-1', email: 'e@example.com', status: 'active' } },
      ['playerId', 'status'],
      correlationId,
    );

    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ playerId: 'p-1', status: 'active' }) }],
      structuredContent: { playerId: 'p-1', status: 'active' },
      _meta: { [CORRELATION_ID_META_KEY]: correlationId },
    });
  });

  it('returns a failure as an error result carrying only its code, with no structured content', () => {
    const result = toCallToolResult(
      { ok: false, error: 'player_not_found' },
      ['playerId'],
      correlationId,
    );

    expect(result).toEqual({
      content: [{ type: 'text', text: '{"error":"player_not_found"}' }],
      isError: true,
      _meta: { [CORRELATION_ID_META_KEY]: correlationId },
    });
    expect(result).not.toHaveProperty('structuredContent');
  });

  it('carries input issues beside the code and nothing else', () => {
    const issues = [{ path: 'playerId', message: 'Invalid UUID' }];

    const result = toCallToolResult(
      { ok: false, error: 'invalid_input', issues },
      ['playerId'],
      correlationId,
    );

    expect(result.isError).toBe(true);
    expect(result).not.toHaveProperty('structuredContent');
    expect(textOf(result)).toStrictEqual({ error: 'invalid_input', issues });
  });
});
