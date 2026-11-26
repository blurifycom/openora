import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  dlqKey,
  isBusyGroupError,
  streamIdAfter,
  streamIdTime,
  streamKey,
} from '../redis-streams-broker.js';

describe('streamKey and dlqKey', () => {
  it.each(['wallet.credited', 'a', '', 'oss:evt:nested', 'topic:with:colons'])(
    'maps topic %j to its stream and dead-letter keys',
    (topic) => {
      expect(streamKey(topic)).toBe(`oss:evt:${topic}`);
      expect(dlqKey(streamKey(topic))).toBe(`oss:dlq:${topic}`);
    },
  );
});

describe('streamIdTime', () => {
  it.each([
    ['1700000000000-0', 1_700_000_000_000],
    ['1700000000000-42', 1_700_000_000_000],
    ['0-1', 0],
    ['1700000000000', 1_700_000_000_000],
  ])('reads the millisecond part of %s', (id, expected) => {
    expect(streamIdTime(id)).toBe(expected);
  });
});

describe('streamIdAfter', () => {
  it.each([
    ['1700000000001-0', '1700000000000-99', true],
    ['1700000000000-99', '1700000000001-0', false],
    ['1700000000000-2', '1700000000000-10', false],
    ['1700000000000-10', '1700000000000-2', true],
    ['1700000000000-5', '1700000000000-5', false],
    ['999-0', '1000-0', false],
    ['1700000000000-1', '1700000000000', true],
    ['0-1', '0-0', true],
  ])('%s after %s is %s', (a, b, expected) => {
    expect(streamIdAfter(a, b)).toBe(expected);
  });

  it('orders sequence numbers past 2^53 within one millisecond', () => {
    expect(streamIdAfter('1700000000000-9007199254740993', '1700000000000-9007199254740992')).toBe(
      true,
    );
  });

  it('orders ids exactly like their (time, sequence) pairs', () => {
    const id = fc.tuple(fc.nat({ max: 2 ** 45 }), fc.nat({ max: 2 ** 31 }));
    fc.assert(
      fc.property(id, id, ([aTime, aSeq], [bTime, bSeq]) => {
        const expected = aTime > bTime || (aTime === bTime && aSeq > bSeq);
        expect(streamIdAfter(`${aTime}-${aSeq}`, `${bTime}-${bSeq}`)).toBe(expected);
      }),
    );
  });

  it('is never true both ways', () => {
    const id = fc.tuple(fc.nat({ max: 5 }), fc.nat({ max: 5 })).map(([t, s]) => `${t}-${s}`);
    fc.assert(
      fc.property(id, id, (a, b) => {
        expect(streamIdAfter(a, b) && streamIdAfter(b, a)).toBe(false);
      }),
    );
  });
});

describe('isBusyGroupError', () => {
  it.each([
    [new Error('BUSYGROUP Consumer Group name already exists'), true],
    [new Error('ReplyError: BUSYGROUP'), true],
    [new Error('busygroup'), false],
    [new Error('NOGROUP No such key'), false],
    ['BUSYGROUP Consumer Group name already exists', false],
    [{ message: 'BUSYGROUP' }, false],
    [null, false],
  ])('%s is %s', (err, expected) => {
    expect(isBusyGroupError(err)).toBe(expected);
  });
});
