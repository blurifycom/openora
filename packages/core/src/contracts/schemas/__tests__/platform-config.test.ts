import { describe, expect, it } from 'vitest';
import { definePlatformConfig } from '../platform-config.js';

describe('definePlatformConfig', () => {
  it('canonicalizes attachment hosts before services consume the config', () => {
    const config = definePlatformConfig({
      chat: { allowedAttachmentHosts: ['MEDIA.EXAMPLE.COM'] },
    });

    expect(config.chat.allowedAttachmentHosts).toEqual(['media.example.com']);
  });

  it('rejects attachment hosts that include URL components', () => {
    expect(() =>
      definePlatformConfig({
        chat: { allowedAttachmentHosts: ['https://media.example.com/path'] },
      }),
    ).toThrow(/chat\.allowedAttachmentHosts\.0/);
  });
});
