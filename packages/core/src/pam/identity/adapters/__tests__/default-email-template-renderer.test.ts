import { describe, it, expect } from 'vitest';
import { DefaultEmailTemplateRenderer } from '../default-email-template-renderer.js';

describe('DefaultEmailTemplateRenderer', () => {
  const renderer = new DefaultEmailTemplateRenderer();

  it('renders the verifyEmail template with the url and token interpolated', () => {
    const result = renderer.render(
      'verifyEmail',
      { url: 'https://example.com/verify', token: 'tok123' },
      'de',
    );

    expect(result).toEqual({
      subject: 'Verify your email',
      body: 'Verify your email using this link: https://example.com/verify\n\nVerification token: tok123',
    });
  });

  it('renders the resetPasswordOtp template with the otp interpolated', () => {
    const result = renderer.render('resetPasswordOtp', { otp: '123456' }, 'fr');

    expect(result).toEqual({
      subject: 'Reset your password',
      body: 'Your password reset code is: 123456',
    });
  });

  it('ignores locale - always English', () => {
    const en = renderer.render('resetPasswordOtp', { otp: '000000' }, 'en');
    const de = renderer.render('resetPasswordOtp', { otp: '000000' }, 'de');

    expect(en).toEqual(de);
  });
});
