import { describe, it, expect } from 'vitest';
import { validateAttachment } from '../moderation/index.js';

const baseAttachment = {
  url: 'https://media.example.com/foo.gif',
  previewUrl: 'https://media.example.com/foo-preview.gif',
};

describe('validateAttachment', () => {
  it('passes when both urls resolve to an allow-listed host', () => {
    expect(validateAttachment(baseAttachment, ['media.example.com'])).toEqual({ ok: true });
  });

  it('rejects when the host is not on the allow-list', () => {
    expect(
      validateAttachment(
        { url: 'https://evil.example.net/foo.gif', previewUrl: 'https://evil.example.net/foo.gif' },
        ['media.example.com'],
      ),
    ).toEqual({ ok: false, reason: 'host not allowed: evil.example.net' });
  });

  it('rejects a non-https protocol', () => {
    expect(
      validateAttachment(
        {
          url: 'http://media.example.com/foo.gif',
          previewUrl: 'https://media.example.com/foo.gif',
        },
        ['media.example.com'],
      ),
    ).toEqual({ ok: false, reason: 'unsupported protocol: http:' });

    expect(
      validateAttachment(
        {
          url: 'javascript:alert(1)',
          previewUrl: 'https://media.example.com/foo.gif',
        },
        ['media.example.com'],
      ),
    ).toEqual({ ok: false, reason: 'unsupported protocol: javascript:' });

    expect(
      validateAttachment(
        {
          url: 'data:text/html,x',
          previewUrl: 'https://media.example.com/foo.gif',
        },
        ['media.example.com'],
      ),
    ).toEqual({ ok: false, reason: 'unsupported protocol: data:' });
  });

  it('allows a subdomain of an allow-listed host', () => {
    expect(
      validateAttachment(
        { url: 'https://cdn.example.com/foo.gif', previewUrl: 'https://cdn.example.com/foo.gif' },
        ['example.com'],
      ),
    ).toEqual({ ok: true });
  });

  it('rejects the previewUrl even when the url is allowed', () => {
    expect(
      validateAttachment(
        {
          url: 'https://media.example.com/foo.gif',
          previewUrl: 'https://evil.example.net/foo.gif',
        },
        ['media.example.com'],
      ),
    ).toEqual({ ok: false, reason: 'host not allowed: evil.example.net' });
  });
});
