import { describe, it, expect } from 'vitest';
import { DefaultEmailTemplateRenderer } from '../default-email-template-renderer.js';

describe('DefaultEmailTemplateRenderer', () => {
  const renderer = new DefaultEmailTemplateRenderer();

  it('renders the verifyEmail template with the otp interpolated', () => {
    const result = renderer.render('verifyEmail', { otp: '123456' }, 'de');

    expect(result).toEqual({
      subject: 'Verify your email',
      body: 'Your email verification code is: 123456',
    });
  });

  it('renders the resetPasswordOtp template with the otp interpolated', () => {
    const result = renderer.render(
      'resetPasswordOtp',
      { otp: '123456', email: 'test@example.com' },
      'fr',
    );

    expect(result).toEqual({
      subject: 'Reset your password',
      body: 'Your password reset code is: 123456',
    });
  });

  it('ignores locale - always English', () => {
    const en = renderer.render(
      'resetPasswordOtp',
      { otp: '000000', email: 'test@example.com' },
      'en',
    );
    const de = renderer.render(
      'resetPasswordOtp',
      { otp: '000000', email: 'test@example.com' },
      'de',
    );

    expect(en).toEqual(de);
  });
});
