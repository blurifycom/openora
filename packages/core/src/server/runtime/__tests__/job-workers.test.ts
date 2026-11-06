import { describe, it, expect } from 'vitest';
import { parseJobWorkers, selectJobWorkers } from '../job-workers.js';

const registered = [
  { queue: 'reports.daily' },
  { queue: 'reports.weekly' },
  { queue: 'reportsx' },
  { queue: 'promo-sweep' },
  { queue: 'mail' },
];

const consumedBy = (raw: string) =>
  selectJobWorkers(registered, parseJobWorkers(raw)).consumed.map((r) => r.queue);

describe('parseJobWorkers', () => {
  it('reads unset or blank as every queue, with no selection at all', () => {
    expect(parseJobWorkers(undefined)).toBeNull();
    expect(parseJobWorkers('')).toBeNull();
    expect(parseJobWorkers('  ')).toBeNull();
  });

  it('reads the keywords and patterns, split on commas or spaces', () => {
    expect(parseJobWorkers('*')).toEqual({ include: null, exclude: [] });
    expect(parseJobWorkers('all')).toEqual({ include: null, exclude: [] });
    expect(parseJobWorkers('none')).toEqual({ include: [], exclude: [] });
    expect(parseJobWorkers('mail reports.*,,promo-*')).toEqual({
      include: ['mail', 'reports.*', 'promo-*'],
      exclude: [],
    });
    expect(parseJobWorkers('!reports.*')).toEqual({ include: null, exclude: ['reports.*'] });
    expect(parseJobWorkers('*,!mail')).toEqual({ include: null, exclude: ['mail'] });
    expect(parseJobWorkers('reports.*,!reports.weekly')).toEqual({
      include: ['reports.*'],
      exclude: ['reports.weekly'],
    });
  });

  it.each([
    ['none,mail', /"none" stands alone/],
    ['*,mail', /exclude with "!"/],
    ['re*ports', /only at its end/],
    ['*mail', /only at its end/],
    ['!', /names no queue/],
  ])('refuses %s', (raw, error) => {
    expect(() => parseJobWorkers(raw)).toThrow(error);
  });
});

describe('selectJobWorkers', () => {
  it('consumes every queue without a selection', () => {
    expect(selectJobWorkers(registered, null)).toEqual({
      consumed: registered,
      skipped: [],
      idleExclusions: [],
    });
  });

  it('matches a name exactly and a prefix pattern by its prefix', () => {
    expect(consumedBy('mail')).toEqual(['mail']);
    expect(consumedBy('reports.*')).toEqual(['reports.daily', 'reports.weekly']);
    expect(consumedBy('promo-*')).toEqual(['promo-sweep']);
  });

  it('consumes every queue but the excluded ones when only exclusions are given', () => {
    expect(consumedBy('!reports.*')).toEqual(['reportsx', 'promo-sweep', 'mail']);
    expect(consumedBy('!*')).toEqual([]);
  });

  it('takes the included queues minus the excluded ones', () => {
    expect(consumedBy('reports.*,mail,!reports.weekly')).toEqual(['reports.daily', 'mail']);
  });

  it('consumes nothing with none, and reports what it skips', () => {
    const { consumed, skipped } = selectJobWorkers(registered, parseJobWorkers('none'));

    expect(consumed).toEqual([]);
    expect(skipped).toEqual(registered);
  });

  it('fails on an inclusion no registered queue matches, naming it and the queues', () => {
    expect(() => selectJobWorkers(registered, parseJobWorkers('reprots.*,mail'))).toThrow(
      /does not register: reprots\.\*\. Registered queues: reports\.daily, .*mail/,
    );
  });

  it('allows an exclusion nothing matches and reports it as idle', () => {
    const selected = selectJobWorkers(registered, parseJobWorkers('!absent.*,!mail'));

    expect(selected.idleExclusions).toEqual(['absent.*']);
    expect(selected.consumed.map((r) => r.queue)).not.toContain('mail');
  });

  it('keeps two workers on one queue together', () => {
    const twice = [{ queue: 'mail' }, { queue: 'mail' }, { queue: 'reportsx' }];

    expect(selectJobWorkers(twice, parseJobWorkers('mail')).consumed).toHaveLength(2);
  });
});
