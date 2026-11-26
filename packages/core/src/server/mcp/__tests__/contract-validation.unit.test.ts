import { describe, expect, it } from 'vitest';
import { MCP_ACTION_TYPE_ID_PATTERN, MCP_TOOL_ID_PATTERN } from '@openora/core/contracts';
import { idRejection, isText, reversibleRejection } from '../contract-validation.js';

describe('idRejection', () => {
  it.each(['player.summary', 'ggr.summary', 'a', 'payments.flow_daily', `a${'b'.repeat(63)}`])(
    'accepts tool id %j',
    (id) => {
      expect(idRejection(id, MCP_TOOL_ID_PATTERN, 'x')).toBeNull();
    },
  );

  it.each([
    ['too long', `a${'b'.repeat(64)}`],
    ['upper case', 'Player.summary'],
    ['leading dot', '.player'],
    ['trailing dot', 'player.'],
    ['double dot', 'player..summary'],
    ['segment starting with a digit', 'player.1summary'],
    ['dash', 'player-summary'],
    ['trailing newline', 'player.summary\n'],
    ['cyrillic lookalike', 'plаyer.summary'],
    ['empty', ''],
    ['number', 42],
    ['null', null],
    ['undefined', undefined],
  ])('rejects tool id that is %s', (_name, id) => {
    const rejection = idRejection(id, MCP_TOOL_ID_PATTERN, 'lowercase dotted segments');
    expect(rejection?.problem).toContain('at most 64 characters');
    expect(rejection?.fix).toBe('use lowercase dotted segments');
  });

  it.each([
    ['hold_withdrawal', true],
    ['ab', true],
    ['a', false],
    ['hold.withdrawal', false],
    ['_hold', false],
  ])('applies the action type pattern to %j', (id, accepted) => {
    expect(idRejection(id, MCP_ACTION_TYPE_ID_PATTERN, 'x') === null).toBe(accepted);
  });
});

describe('isText', () => {
  it.each([
    ['a', 1, true],
    ['abc', 3, true],
    ['abcd', 3, false],
    ['  a  ', 5, true],
    ['  a  ', 4, false],
    ['', 10, false],
    ['   ', 10, false],
    ['\n\t', 10, false],
    [42, 10, false],
    [null, 10, false],
    [undefined, 10, false],
    [['a'], 10, false],
  ])('isText(%j, %i) is %s', (value, maxLength, expected) => {
    expect(isText(value, maxLength)).toBe(expected);
  });
});

describe('reversibleRejection', () => {
  it.each([true, false])('accepts %s', (value) => {
    expect(reversibleRejection(value)).toBeNull();
  });

  it.each([['true'], [0], [1], [null], [undefined], [{}]])('rejects %j', (value) => {
    expect(reversibleRejection(value)).toEqual({
      problem: 'reversible must be a boolean',
      fix: 'state whether an approved action can be undone',
    });
  });
});
