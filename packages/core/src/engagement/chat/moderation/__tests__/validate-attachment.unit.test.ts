import { describe, expect, it } from 'vitest';
import { validateAttachment, validateUrl } from '../validate-attachment.js';

const HOSTS = ['giphy.com', 'tenor.com'] as const;
const GOOD = 'https://media.giphy.com/media/abc/giphy.gif';

describe('validateUrl', () => {
  it.each([
    GOOD,
    'https://giphy.com/x.gif',
    'https://GIPHY.COM/x.gif',
    'HTTPS://giphy.com/x.gif',
    'https://giphy.com:443/x.gif',
    'https://a.b.c.tenor.com/x.gif',
    'https:giphy.com/x.gif',
  ])('allows %s', (url) => {
    expect(validateUrl(url, HOSTS)).toEqual({ ok: true });
  });

  it('refuses the trailing-dot form of an allowed host', () => {
    expect(validateUrl('https://giphy.com./x.gif', HOSTS)).toEqual({
      ok: false,
      reason: 'host not allowed: giphy.com.',
    });
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:image/gif;base64,R0lGOD',
    'http://giphy.com/x.gif',
    'ftp://giphy.com/x.gif',
    'file:///etc/passwd',
    'blob:https://giphy.com/abc',
    'wss://giphy.com/x',
  ])('refuses the scheme of %s', (url) => {
    const result = validateUrl(url, HOSTS);
    expect(result.ok).toBe(false);
  });

  it.each(['//giphy.com/x.gif', 'giphy.com/x.gif', '/x.gif', '', ' ', 'https://', 'not a url'])(
    'refuses the unparseable or relative %j as an invalid URL',
    (url) => {
      const result = validateUrl(url, HOSTS);
      expect(result.ok).toBe(false);
    },
  );

  it('reports an invalid URL with the raw text', () => {
    expect(validateUrl('//giphy.com/x.gif', HOSTS)).toEqual({
      ok: false,
      reason: 'invalid URL: //giphy.com/x.gif',
    });
  });

  it('names the protocol of a plain http URL', () => {
    expect(validateUrl('http://giphy.com/x.gif', HOSTS)).toEqual({
      ok: false,
      reason: 'unsupported protocol: http:',
    });
  });

  it.each([
    'https://evilgiphy.com/x.gif',
    'https://giphy.com.evil.com/x.gif',
    'https://evil.com/giphy.com',
    'https://evil.com?giphy.com',
    'https://evil.com#giphy.com',
    'https://giphy.com@evil.com/x.gif',
    'https://giphy.com:pw@evil.com/x.gif',
    'https://evil.com\\@giphy.com/x.gif',
    'https://giphy.com%2eevil.com/x.gif',
    'https://notgiphy.com/x.gif',
    'https://giphy.com.evil/x.gif',
    'https://127.0.0.1/x.gif',
    'https://localhost/x.gif',
    'https://[::1]/x.gif',
  ])('refuses the host trick %s', (url) => {
    const result = validateUrl(url, HOSTS);
    expect(result.ok).toBe(false);
  });

  it('judges a userinfo URL by the host after the at sign, so an allowed host stays allowed', () => {
    expect(validateUrl('https://user:pw@giphy.com/x.gif', HOSTS)).toEqual({ ok: true });
  });

  it('refuses every host when the allow list is empty', () => {
    expect(validateUrl(GOOD, [])).toEqual({
      ok: false,
      reason: 'host not allowed: media.giphy.com',
    });
  });

  it('matches allowed hosts case-sensitively, so an upper-case entry never matches', () => {
    expect(validateUrl(GOOD, ['GIPHY.COM']).ok).toBe(false);
  });

  it('refuses an oversize URL that does not parse as a host of the allow list', () => {
    const long = `https://${'a'.repeat(5000)}.giphy.com.evil.com/x.gif`;
    expect(validateUrl(long, HOSTS).ok).toBe(false);
  });
});

describe('validateAttachment', () => {
  it('allows an attachment whose url and preview are on allowed hosts', () => {
    expect(
      validateAttachment({ url: GOOD, previewUrl: 'https://media.tenor.com/p.gif' }, HOSTS),
    ).toEqual({
      ok: true,
    });
  });

  it('refuses when only the preview is off the allow list', () => {
    expect(validateAttachment({ url: GOOD, previewUrl: 'https://evil.com/p.gif' }, HOSTS)).toEqual({
      ok: false,
      reason: 'host not allowed: evil.com',
    });
  });

  it('refuses when only the main url is off the allow list', () => {
    expect(validateAttachment({ url: 'https://evil.com/x.gif', previewUrl: GOOD }, HOSTS)).toEqual({
      ok: false,
      reason: 'host not allowed: evil.com',
    });
  });

  it('reports the main url first when both are bad', () => {
    expect(
      validateAttachment(
        { url: 'javascript:alert(1)', previewUrl: 'https://evil.com/p.gif' },
        HOSTS,
      ),
    ).toEqual({ ok: false, reason: 'unsupported protocol: javascript:' });
  });

  it('refuses a javascript preview behind a good url', () => {
    expect(validateAttachment({ url: GOOD, previewUrl: 'javascript:alert(1)' }, HOSTS).ok).toBe(
      false,
    );
  });
});
