import { describe, expect, it } from 'vitest';
import { parseFlags, required, targetUrlOf } from '../audit-copy.service.js';

const ADMIN = 'postgres://owner:s3cret@db-a.example.test:5432/appdb?sslmode=require';

describe('targetUrlOf', () => {
  it('points the owner credentials at the audit database name', () => {
    const target = new URL(targetUrlOf(ADMIN, 'postgres://app:pw@db-b.example.test/auditdb'));
    expect(target.pathname).toBe('/auditdb');
    expect(target.username).toBe('owner');
    expect(target.password).toBe('s3cret');
    expect(target.host).toBe('db-a.example.test:5432');
    expect(target.searchParams.get('sslmode')).toBe('require');
  });

  it.each([
    ['the same url', ADMIN],
    ['another host with the same name', 'postgres://app:pw@db-b.example.test/appdb'],
    [
      'query params after the same name',
      'postgres://app:pw@db-b.example.test/appdb?sslmode=disable',
    ],
    ['a percent-encoded spelling of the same name', 'postgres://app:pw@db-b.example.test/%61ppdb'],
    ['another port with the same name', 'postgres://app:pw@db-a.example.test:6543/appdb'],
  ])('refuses %s', (_label, auditUrl) => {
    expect(() => targetUrlOf(ADMIN, auditUrl)).toThrow(/other than the main one/);
  });

  it('refuses when the admin url carries the percent-encoded spelling', () => {
    expect(() =>
      targetUrlOf(
        'postgres://owner:pw@h.example.test/%61ppdb',
        'postgres://a:b@h2.example.test/appdb',
      ),
    ).toThrow(/other than the main one/);
  });

  it('does not put either password in the refusal', () => {
    expect(() => targetUrlOf(ADMIN, ADMIN)).toThrow(
      expect.not.objectContaining({ message: expect.stringContaining('s3cret') }),
    );
  });

  it.each(['AppDB', 'appdb2', 'app'])('accepts the distinct name %s', (name) => {
    const target = new URL(targetUrlOf(ADMIN, `postgres://a:b@h.example.test/${name}`));
    expect(target.pathname).toBe(`/${name}`);
  });
});

describe('required', () => {
  it('returns the value', () => {
    expect(required({ K: 'v' }, 'K')).toBe('v');
  });

  it.each([undefined, ''])('names the key when it is %j', (value) => {
    expect(() => required({ K: value }, 'K')).toThrow('K is required');
  });

  it('names the key when it is missing', () => {
    expect(() => required({}, 'AUDIT_DATABASE_URL')).toThrow('AUDIT_DATABASE_URL is required');
  });

  it('does not echo other variables', () => {
    expect(() => required({ OTHER: 'hunter2' }, 'K')).toThrow(
      expect.not.objectContaining({ message: expect.stringContaining('hunter2') }),
    );
  });
});

describe('parseFlags', () => {
  it.each([
    [[], { apply: false, fence: false, drain: false }],
    [['--apply'], { apply: true, fence: false, drain: false }],
    [['--fence'], { apply: false, fence: true, drain: false }],
    [['--drain-outbox'], { apply: false, fence: false, drain: true }],
    [['--apply', '--fence'], { apply: true, fence: true, drain: false }],
  ])('reads %j', (argv, expected) => {
    expect(parseFlags(argv)).toEqual(expected);
  });

  it.each([
    ['--unknown'],
    ['--apply=true'],
    ['postgres://owner:s3cret@h.example.test/appdb'],
    ['--database', 'postgres://owner:s3cret@h.example.test/appdb'],
    ['-a'],
  ])('rejects %j with the usage line only', (...argv) => {
    let message = '';
    try {
      parseFlags(argv);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toBe('usage: openora-audit-copy [--apply] [--fence | --drain-outbox]');
  });
});
