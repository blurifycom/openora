import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Account } from '@openora/core/contracts';
import {
  ChatMessageBlockedError,
  gateContent,
  latestExpiry,
  parseMentionedUsernames,
  visibleInRoster,
} from '../chat.service.js';
import { assertNotSelfModeration } from '../chat-room-moderation.service.js';
import { ChatRoomSelfModerationError } from '../errors/chat-moderation.errors.js';

const USER = 'a1b2c3d4-0000-4000-8000-000000000001';
const OTHER = 'a1b2c3d4-0000-4000-8000-000000000002';
const CREATOR = 'a1b2c3d4-0000-4000-8000-000000000003';

const account = (over: Partial<Account>): Account => ({
  userId: USER,
  username: 'someone',
  name: 'Some One',
  avatarUrl: null,
  role: 'user',
  isActive: true,
  excluded: false,
  player: null,
  ...over,
});

describe('parseMentionedUsernames', () => {
  it.each([
    ['hello @alice', ['alice']],
    ['@alice', ['alice']],
    ['@Alice and @ALICE and @alice', ['alice']],
    ['@alice, @bob! and @carol?', ['alice', 'bob', 'carol']],
    ['(@alice)', ['alice']],
    ['"@alice"', ['alice']],
    ['@alice@bob', ['alice']],
    ['@alice.bob', ['alice']],
    ['@a_b_1', ['a_b_1']],
    ['@Aa', ['aa']],
    ['line\n@alice\n@bob', ['alice', 'bob']],
    ['@alice @alice @alice', ['alice']],
  ])('reads %j as %j', (content, expected) => {
    expect(parseMentionedUsernames(content)).toEqual(expected);
  });

  it.each([
    'mail me at alice@example.com',
    'a@bc',
    'x.@alice',
    'foo.@bar',
    '1@23',
    '_@abc',
    '@',
    '@@',
    '@a',
    '@ alice',
    '@-alice',
    '@.alice',
    '',
    'no mentions here',
  ])('finds nothing in %j', (content) => {
    expect(parseMentionedUsernames(content)).toEqual([]);
  });

  it('accepts a two character name and refuses a one character name', () => {
    expect(parseMentionedUsernames('@ab @c')).toEqual(['ab']);
  });

  it('reads at most 32 characters of a long name', () => {
    expect(parseMentionedUsernames(`@${'a'.repeat(32)}`)).toEqual(['a'.repeat(32)]);
    expect(parseMentionedUsernames(`@${'a'.repeat(40)}`)).toEqual(['a'.repeat(32)]);
  });

  it('stops after 20 distinct mentions', () => {
    const content = Array.from({ length: 50 }, (_, i) => `@user${String(i).padStart(2, '0')}`).join(
      ' ',
    );
    const parsed = parseMentionedUsernames(content);
    expect(parsed).toHaveLength(20);
    expect(parsed[0]).toBe('user00');
    expect(parsed[19]).toBe('user19');
  });

  it('counts duplicates once toward the cap of 20', () => {
    const content = `${'@dup '.repeat(100)}@other`;
    expect(parseMentionedUsernames(content)).toEqual(['dup', 'other']);
  });

  it('matches only ASCII name characters, so a unicode lookalike never starts or ends a name wrongly', () => {
    expect(parseMentionedUsernames('@alicé')).toEqual(['alic']);
    expect(parseMentionedUsernames('@аlice')).toEqual([]);
  });

  it('never returns more than 20 names, an uppercase letter or a duplicate', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (content) => {
        const parsed = parseMentionedUsernames(content);
        expect(parsed.length).toBeLessThanOrEqual(20);
        expect(new Set(parsed).size).toBe(parsed.length);
        for (const name of parsed) {
          expect(name).toBe(name.toLowerCase());
          expect(name).toMatch(/^[a-z0-9_]{2,32}$/);
        }
      }),
    );
  });
});

describe('visibleInRoster', () => {
  const accounts = new Map<string, Account>([
    [USER, account({ userId: USER, role: 'user' })],
    [OTHER, account({ userId: OTHER, role: 'admin' })],
    [CREATOR, account({ userId: CREATOR, role: 'super-admin' })],
  ]);
  const hidden = { canSeeAdminUsers: false, creatorId: null };

  it('lists a player to anyone', () => {
    expect(visibleInRoster({ userId: USER, role: 'member' }, accounts, hidden)).toBe(true);
  });

  it('hides a staff member from a viewer who is not staff', () => {
    expect(visibleInRoster({ userId: OTHER, role: 'member' }, accounts, hidden)).toBe(false);
  });

  it('hides a staff moderator, only an owner is listed', () => {
    expect(visibleInRoster({ userId: OTHER, role: 'moderator' }, accounts, hidden)).toBe(false);
  });

  it('lists a staff owner of the room', () => {
    expect(visibleInRoster({ userId: OTHER, role: 'owner' }, accounts, hidden)).toBe(true);
  });

  it('lists the staff member who created the room', () => {
    expect(
      visibleInRoster({ userId: CREATOR, role: 'member' }, accounts, {
        ...hidden,
        creatorId: CREATOR,
      }),
    ).toBe(true);
  });

  it('does not list a staff member because somebody else created the room', () => {
    expect(
      visibleInRoster({ userId: OTHER, role: 'member' }, accounts, {
        ...hidden,
        creatorId: CREATOR,
      }),
    ).toBe(false);
  });

  it('lists every staff member to a staff viewer', () => {
    expect(
      visibleInRoster({ userId: OTHER, role: 'member' }, accounts, {
        canSeeAdminUsers: true,
        creatorId: null,
      }),
    ).toBe(true);
  });

  it('lists an account the identity service does not know', () => {
    expect(visibleInRoster({ userId: 'missing', role: 'member' }, accounts, hidden)).toBe(true);
  });

  it('keeps a null creator from matching an unknown member', () => {
    expect(
      visibleInRoster({ userId: OTHER, role: 'member' }, accounts, {
        canSeeAdminUsers: false,
        creatorId: null,
      }),
    ).toBe(false);
  });
});

describe('gateContent', () => {
  it('returns clean content', () => {
    expect(gateContent('good luck everyone')).toBe('good luck everyone');
  });

  it('refuses profanity with the blocked error', () => {
    expect(() => gateContent('you are a fuck')).toThrow(ChatMessageBlockedError);
  });

  it('refuses profanity hidden by leetspeak and repeated letters', () => {
    expect(() => gateContent('f u c k')).not.toThrow();
    expect(() => gateContent('fuuuuck')).toThrow(ChatMessageBlockedError);
    expect(() => gateContent('fvck')).toThrow(ChatMessageBlockedError);
  });

  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>x</script>'])(
    'defangs the dangerous scheme in %j',
    (content) => {
      const result = gateContent(`click ${content}`);
      expect(result.toLowerCase()).not.toContain('javascript:');
      expect(result.toLowerCase()).not.toContain('data:text/html');
    },
  );
});

describe('latestExpiry', () => {
  const at = (iso: string) => new Date(iso);
  const EARLY = at('2026-03-01T00:00:00.000Z');
  const LATE = at('2026-04-01T00:00:00.000Z');

  it('returns null for no restrictions', () => {
    expect(latestExpiry([])).toBeNull();
  });

  it('returns the only expiry', () => {
    expect(latestExpiry([EARLY])).toEqual(EARLY);
  });

  it('returns the latest of several', () => {
    expect(latestExpiry([EARLY, LATE, EARLY])).toEqual(LATE);
  });

  it('is permanent when any restriction is permanent', () => {
    expect(latestExpiry([EARLY, null, LATE])).toBeNull();
    expect(latestExpiry([null])).toBeNull();
  });

  it('returns a new date and not one of its inputs', () => {
    expect(latestExpiry([LATE])).not.toBe(LATE);
  });

  it('is the maximum and independent of order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.date({ min: new Date(0), max: new Date('2100-01-01'), noInvalidDate: true }), {
          minLength: 1,
          maxLength: 10,
        }),
        (dates) => {
          const expected = new Date(Math.max(...dates.map((date) => date.getTime())));
          expect(latestExpiry(dates)).toEqual(expected);
          expect(latestExpiry([...dates].reverse())).toEqual(expected);
        },
      ),
    );
  });

  it('is permanent whenever a null is anywhere in the list', () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.date({ noInvalidDate: true }), { nil: null }), {
          minLength: 1,
          maxLength: 10,
        }),
        (expiries) => {
          expect(latestExpiry(expiries) === null).toBe(expiries.some((expiry) => expiry === null));
        },
      ),
    );
  });
});

describe('assertNotSelfModeration', () => {
  it('refuses a moderator acting on themselves', () => {
    expect(() => assertNotSelfModeration(USER, USER)).toThrow(ChatRoomSelfModerationError);
  });

  it('allows acting on someone else', () => {
    expect(() => assertNotSelfModeration(USER, OTHER)).not.toThrow();
  });

  it('compares ids exactly, so a different case is another user', () => {
    expect(() => assertNotSelfModeration(USER, USER.toUpperCase())).not.toThrow();
  });
});
