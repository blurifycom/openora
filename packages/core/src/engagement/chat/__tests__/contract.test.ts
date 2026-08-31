import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SendRoomMessageInputSchema, SendGlobalMessageInputSchema } from '../contract/index.js';

describe('SendRoomMessageInputSchema', () => {
  it('rejects a message with neither content nor an attachment', () => {
    const result = SendRoomMessageInputSchema.safeParse({ roomId: randomUUID(), content: '' });
    expect(result.success).toBe(false);
  });

  it('accepts content with no attachment', () => {
    const result = SendRoomMessageInputSchema.safeParse({
      roomId: randomUUID(),
      content: 'hello',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an attachment with no content', () => {
    const result = SendRoomMessageInputSchema.safeParse({
      roomId: randomUUID(),
      content: '',
      attachment: {
        kind: 'gif',
        provider: 'example',
        externalId: 'abc123',
        url: 'https://media.example.com/abc123.gif',
        previewUrl: 'https://media.example.com/abc123-preview.gif',
        width: 320,
        height: 240,
        title: 'a gif',
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('SendGlobalMessageInputSchema', () => {
  it('rejects a message with neither content nor an attachment', () => {
    const result = SendGlobalMessageInputSchema.safeParse({ content: '' });
    expect(result.success).toBe(false);
  });

  it('accepts content with no attachment', () => {
    const result = SendGlobalMessageInputSchema.safeParse({ content: 'hello' });
    expect(result.success).toBe(true);
  });
});
