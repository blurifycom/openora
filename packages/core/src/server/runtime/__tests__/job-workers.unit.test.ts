import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { matches, parseJobWorkers, selectJobWorkers } from '../job-workers.js';

const reg = (queue: string) => ({ queue });
const REGISTERED = [
  reg('mail-send'),
  reg('wallet-settle'),
  reg('wallet-sweep'),
  reg('casino-round'),
];

describe('parseJobWorkers', () => {
  it.each([[undefined], [''], ['   '], [' , ,']])('treats %j as every queue', (raw) => {
    expect(parseJobWorkers(raw)).toBeNull();
  });

  it.each([
    ['mail-send', { include: ['mail-send'], exclude: [] }],
    ['mail-send, wallet-*', { include: ['mail-send', 'wallet-*'], exclude: [] }],
    ['mail-send wallet-*', { include: ['mail-send', 'wallet-*'], exclude: [] }],
    ['*', { include: null, exclude: [] }],
    ['all', { include: null, exclude: [] }],
    ['none', { include: [], exclude: [] }],
    ['!mail-send', { include: null, exclude: ['mail-send'] }],
    ['all,!wallet-*', { include: null, exclude: ['wallet-*'] }],
    ['wallet-*,!wallet-sweep', { include: ['wallet-*'], exclude: ['wallet-sweep'] }],
    ['!*', { include: null, exclude: ['*'] }],
  ])('parses %j', (raw, expected) => {
    expect(parseJobWorkers(raw)).toEqual(expected);
  });

  it.each([
    ['a bare bang', '!'],
    ['a star inside a name', 'wal*let'],
    ['a star inside an exclusion', '!wal*let'],
    ['none with a queue', 'none,mail-send'],
    ['none with an exclusion', 'none,!mail-send'],
    ['none twice', 'none,none'],
    ['all with a named queue', 'all,mail-send'],
    ['star with a named queue', '*,mail-send'],
  ])('refuses %s', (_name, raw) => {
    expect(() => parseJobWorkers(raw)).toThrow(/JOB_WORKERS/);
  });
});

describe('matches', () => {
  it.each([
    ['mail-send', 'mail-send', true],
    ['mail-send', 'mail-sender', false],
    ['mail-send', 'Mail-send', false],
    ['mail-*', 'mail-send', true],
    ['mail-*', 'mail-', true],
    ['mail-*', 'mail', false],
    ['*', 'anything', true],
    ['*', '', true],
  ])('%j matches %j: %s', (pattern, queue, expected) => {
    expect(matches(pattern, queue)).toBe(expected);
  });
});

describe('selectJobWorkers', () => {
  it('consumes every registration without a selection', () => {
    expect(selectJobWorkers(REGISTERED, null)).toEqual({
      consumed: REGISTERED,
      skipped: [],
      idleExclusions: [],
    });
  });

  it('consumes nothing for none', () => {
    const selected = selectJobWorkers(REGISTERED, { include: [], exclude: [] });
    expect(selected.consumed).toEqual([]);
    expect(selected.skipped).toEqual(REGISTERED);
  });

  it('lets an exclusion win over an inclusion', () => {
    const selected = selectJobWorkers(REGISTERED, {
      include: ['wallet-*'],
      exclude: ['wallet-sweep'],
    });
    expect(selected.consumed).toEqual([reg('wallet-settle')]);
    expect(selected.skipped).toEqual([reg('mail-send'), reg('wallet-sweep'), reg('casino-round')]);
  });

  it('reports exclusions no registered queue matches without failing', () => {
    expect(
      selectJobWorkers(REGISTERED, { include: null, exclude: ['sportsbook-*', 'mail-send'] })
        .idleExclusions,
    ).toEqual(['sportsbook-*']);
  });

  it('fails the boot for an included queue nothing registers', () => {
    expect(() => selectJobWorkers(REGISTERED, { include: ['mail-sned'], exclude: [] })).toThrow(
      /mail-sned/,
    );
  });

  it('fails the boot for an included prefix nothing registers', () => {
    expect(() => selectJobWorkers([], { include: ['wallet-*'], exclude: [] })).toThrow(/\(none\)/);
  });

  it('keeps every registration of a queue registered twice together', () => {
    const twice = [reg('mail-send'), reg('mail-send')];
    expect(selectJobWorkers(twice, { include: ['mail-send'], exclude: [] }).consumed).toEqual(
      twice,
    );
  });

  it('splits registrations into consumed and skipped without loss or overlap', () => {
    const queue = fc.constantFrom('mail-send', 'wallet-settle', 'wallet-sweep', 'casino-round');
    const pattern = fc.constantFrom('mail-send', 'wallet-*', 'casino-round', '*', 'other-*');
    fc.assert(
      fc.property(fc.array(queue, { minLength: 1 }), fc.array(pattern), (queues, exclude) => {
        const registrations = queues.map(reg);
        const { consumed, skipped } = selectJobWorkers(registrations, { include: null, exclude });
        expect(consumed.length + skipped.length).toBe(registrations.length);
        expect(consumed.every((r) => !skipped.includes(r))).toBe(true);
        expect(consumed.every((r) => !exclude.some((p) => matches(p, r.queue)))).toBe(true);
      }),
    );
  });
});
