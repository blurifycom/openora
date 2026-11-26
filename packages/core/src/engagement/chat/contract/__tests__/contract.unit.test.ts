import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_LENGTH, STAFF_USER_ROLES, isStaffRole } from '../constants.js';
import { SendGlobalMessageInputSchema, SendRoomMessageInputSchema } from '../index.js';

const ROOM_ID = '3f6c1d0e-7a41-4b8e-9d52-0a1b2c3d4e5f';
const attachment = {
  kind: 'gif',
  provider: 'giphy',
  externalId: 'abc123',
  url: 'https://media.giphy.com/media/abc/giphy.gif',
  previewUrl: 'https://media.giphy.com/media/abc/preview.gif',
  width: 200,
  height: 100,
  title: 'wave',
} as const;

describe('isStaffRole', () => {
  it.each([
    ['admin', true],
    ['super-admin', true],
    ['player', false],
    ['user', false],
    ['Admin', false],
    ['ADMIN', false],
    ['admin ', false],
    [' admin', false],
    ['superadmin', false],
    ['super_admin', false],
    ['', false],
    [undefined, false],
  ])('role %j is staff: %s', (role, expected) => {
    expect(isStaffRole(role)).toBe(expected);
  });

  it('agrees with the staff role list', () => {
    for (const role of STAFF_USER_ROLES) {
      expect(isStaffRole(role)).toBe(true);
    }
  });
});

describe.each([
  ['SendGlobalMessageInputSchema', SendGlobalMessageInputSchema, {}],
  ['SendRoomMessageInputSchema', SendRoomMessageInputSchema, { roomId: ROOM_ID }],
] as const)('%s content or attachment rule', (_name, schema, base) => {
  it('accepts text without an attachment', () => {
    expect(schema.safeParse({ ...base, content: 'hello' }).success).toBe(true);
  });

  it('accepts an attachment without text', () => {
    expect(schema.safeParse({ ...base, attachment }).success).toBe(true);
  });

  it('accepts an attachment with empty text', () => {
    expect(schema.safeParse({ ...base, content: '', attachment }).success).toBe(true);
  });

  it.each([
    [{}],
    [{ content: '' }],
    [{ content: '   ' }],
    [{ content: '\n\t ' }],
    [{ attachment: null }],
    [{ attachment: undefined }],
    [{ content: '  ', attachment: null }],
  ])('refuses the empty message %j', (input) => {
    expect(schema.safeParse({ ...base, ...input }).success).toBe(false);
  });

  it('refuses text longer than the message limit', () => {
    expect(schema.safeParse({ ...base, content: 'a'.repeat(MAX_MESSAGE_LENGTH + 1) }).success).toBe(
      false,
    );
  });

  it('accepts text of exactly the message limit', () => {
    expect(schema.safeParse({ ...base, content: 'a'.repeat(MAX_MESSAGE_LENGTH) }).success).toBe(
      true,
    );
  });

  it('trims the content before counting it', () => {
    const parsed = schema.safeParse({ ...base, content: `  ${'a'.repeat(MAX_MESSAGE_LENGTH)}  ` });
    expect(parsed.success).toBe(true);
  });

  it('refuses a malformed attachment even with text', () => {
    expect(
      schema.safeParse({ ...base, content: 'hi', attachment: { ...attachment, kind: 'exe' } })
        .success,
    ).toBe(false);
  });
});
