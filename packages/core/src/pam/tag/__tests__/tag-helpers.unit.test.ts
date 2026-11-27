import { DatabaseError } from 'pg';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { tagKeys } from '@openora/core/contracts';
import { PlayerTagAssignMetadataSchema, SYSTEM_ACTOR_ID } from '../contract/index.js';
import { manualReviewRefusal } from '../plugin.js';
import { tagKeysOf } from '../adapters/player-segment-reader.service.js';
import { isPendingKycStatus } from '../service/tag-evaluation.service.js';
import {
  mergeAssignMetadata,
  pgErrorCode,
  resolveRemovalReason,
  TagRemovalReasonRequiredError,
  tagChangeAuditEntry,
} from '../service/tag.service.js';

type Metadata = NonNullable<Parameters<typeof mergeAssignMetadata>[0]>;

const amountBreach = (amount: string): NonNullable<Metadata['amountBreach']> => ({
  amount,
  threshold: '100.00',
});
const countBreach = (count: number): NonNullable<Metadata['countBreach']> => ({
  count,
  thresholdCount: 3,
  thresholdDays: 7,
});

describe('mergeAssignMetadata', () => {
  it('returns existing when nothing is incoming', () => {
    const existing = { amountBreach: amountBreach('500.00'), countBreach: null };
    expect(mergeAssignMetadata(existing, null)).toBe(existing);
    expect(mergeAssignMetadata(existing, undefined)).toBe(existing);
    expect(mergeAssignMetadata(null, null)).toBeNull();
  });

  it('adopts incoming when nothing was recorded', () => {
    const incoming = { amountBreach: amountBreach('500.00'), countBreach: null };
    expect(mergeAssignMetadata(null, incoming)).toBe(incoming);
  });

  it('never overwrites a recorded amount breach with fresher numbers', () => {
    const existing = { amountBreach: amountBreach('500.00'), countBreach: null };
    const merged = mergeAssignMetadata(existing, {
      amountBreach: amountBreach('9999.00'),
      countBreach: countBreach(5),
    });
    expect(merged?.amountBreach).toEqual(amountBreach('500.00'));
    expect(merged?.countBreach).toEqual(countBreach(5));
  });

  it('never overwrites a recorded count breach with fresher numbers', () => {
    const existing = { amountBreach: null, countBreach: countBreach(4) };
    const merged = mergeAssignMetadata(existing, {
      amountBreach: amountBreach('700.00'),
      countBreach: countBreach(40),
    });
    expect(merged?.countBreach).toEqual(countBreach(4));
    expect(merged?.amountBreach).toEqual(amountBreach('700.00'));
  });

  it('returns the same reference once both dimensions are recorded', () => {
    const existing = { amountBreach: amountBreach('500.00'), countBreach: countBreach(4) };
    expect(
      mergeAssignMetadata(existing, {
        amountBreach: amountBreach('1.00'),
        countBreach: countBreach(1),
      }),
    ).toBe(existing);
  });

  it('keeps a dimension empty when neither side recorded it', () => {
    expect(
      mergeAssignMetadata(
        { amountBreach: null, countBreach: null },
        { amountBreach: null, countBreach: null },
      ),
    ).toEqual({ amountBreach: null, countBreach: null });
  });

  it('keeps every recorded dimension for any pair of metadata', () => {
    const metadata = fc.record({
      amountBreach: fc.option(
        fc.nat(1000).map((n) => amountBreach(`${n}.00`)),
        { nil: null },
      ),
      countBreach: fc.option(fc.nat(1000).map(countBreach), { nil: null }),
    });
    fc.assert(
      fc.property(metadata, metadata, (existing, incoming) => {
        const merged = mergeAssignMetadata(existing, incoming);
        expect(PlayerTagAssignMetadataSchema.safeParse(merged).success).toBe(true);
        if (existing.amountBreach) {
          expect(merged?.amountBreach).toEqual(existing.amountBreach);
        }
        if (existing.countBreach) {
          expect(merged?.countBreach).toEqual(existing.countBreach);
        }
        expect(merged?.amountBreach).toEqual(existing.amountBreach ?? incoming.amountBreach);
        expect(merged?.countBreach).toEqual(existing.countBreach ?? incoming.countBreach);
      }),
    );
  });
});

describe('resolveRemovalReason', () => {
  it('requires a reason for a sticky tag', () => {
    expect(() => resolveRemovalReason(undefined, true)).toThrow(TagRemovalReasonRequiredError);
    expect(() => resolveRemovalReason('', true)).toThrow(TagRemovalReasonRequiredError);
    expect(() => resolveRemovalReason('   \n\t', true)).toThrow(TagRemovalReasonRequiredError);
  });

  it('trims a given reason', () => {
    expect(resolveRemovalReason('  fraud cleared  ', true)).toBe('fraud cleared');
    expect(resolveRemovalReason('  fraud cleared  ', false)).toBe('fraud cleared');
  });

  it('falls back to the default for a non sticky tag without a reason', () => {
    expect(resolveRemovalReason(undefined, false)).toBe('manual tag removal');
  });

  it('falls back to the default for a non sticky blank reason', () => {
    expect(resolveRemovalReason('   ', false)).toBe('manual tag removal');
    expect(resolveRemovalReason('', false)).toBe('manual tag removal');
  });
});

describe('pgErrorCode', () => {
  const dbError = (code: string) => {
    const error = new DatabaseError('x', 0, 'error');
    error.code = code;
    return error;
  };

  it('reads the code of the driver error itself', () => {
    expect(pgErrorCode(dbError('23505'))).toBe('23505');
  });

  it('reads the code of a driver error wrapped under .cause', () => {
    expect(pgErrorCode(new Error('Failed query', { cause: dbError('23503') }))).toBe('23503');
  });

  it.each([
    ['null', null],
    ['a string', '23505'],
    ['a plain object with a code', { code: '23505' }],
    ['an error without a cause', new Error('x')],
    ['an error with a plain object cause', new Error('x', { cause: { code: '23505' } })],
    [
      'a doubly wrapped driver error',
      new Error('x', { cause: new Error('y', { cause: dbError('23505') }) }),
    ],
  ])('returns undefined for %s', (_name, error) => {
    expect(pgErrorCode(error)).toBeUndefined();
  });
});

describe('tagChangeAuditEntry', () => {
  const PLAYER = '00000000-0000-4000-8000-0000000000aa';
  const ADMIN = '00000000-0000-4000-8000-0000000000bb';

  it('records an admin action with its context', () => {
    expect(
      tagChangeAuditEntry('tag.player.removed', {
        actorId: ADMIN,
        playerId: PLAYER,
        tagKey: 'withdrawal_lock',
        reason: 'cleared',
        ip: '10.0.0.1',
        userAgent: 'jest',
      }),
    ).toEqual({
      actorType: 'admin',
      actorId: ADMIN,
      action: 'tag.player.removed',
      resourceType: 'player',
      resourceId: PLAYER,
      after: { tagKey: 'withdrawal_lock', reason: 'cleared' },
      ip: '10.0.0.1',
      userAgent: 'jest',
    });
  });

  it('records the system actor as system and nulls missing client meta', () => {
    const entry = tagChangeAuditEntry('tag.player.assigned', {
      actorId: SYSTEM_ACTOR_ID,
      playerId: PLAYER,
      tagKey: 'high_risk',
      reason: 'rule',
    });
    expect(entry.actorType).toBe('system');
    expect(entry.ip).toBeNull();
    expect(entry.userAgent).toBeNull();
    expect(entry.action).toBe('tag.player.assigned');
  });
});

describe('isPendingKycStatus', () => {
  it.each([
    ['pending', true],
    ['resubmission_requested', true],
    ['approved', false],
    ['rejected', false],
    ['not_started', false],
  ] as const)('%s is %s', (status, expected) => {
    expect(isPendingKycStatus(status)).toBe(expected);
  });
});

describe('manualReviewRefusal', () => {
  it.each([
    ['tag_already_active', 'already_in_manual_review'],
    ['player_not_found', 'player_not_found'],
    ['tag_not_found', 'tag_not_found'],
    ['player_not_eligible', 'player_not_eligible'],
    [null, null],
  ] as const)('maps %s to %s', (refusal, expected) => {
    expect(manualReviewRefusal(refusal)).toBe(expected);
  });
});

describe('tagKeysOf', () => {
  it('rejects an empty list', () => {
    expect(() => tagKeysOf([])).toThrow(RangeError);
  });

  it.each([['unknown_tag'], ['VIP'], [' vip'], ['']])('rejects the non tag key %j', (key) => {
    expect(() => tagKeysOf(['vip', key])).toThrow(RangeError);
  });

  it('removes duplicates and keeps first-seen order', () => {
    expect(tagKeysOf(['vip', 'high_risk', 'vip'])).toEqual(['vip', 'high_risk']);
  });

  it('accepts every catalog key', () => {
    expect(tagKeysOf([...tagKeys])).toEqual([...tagKeys]);
  });
});
