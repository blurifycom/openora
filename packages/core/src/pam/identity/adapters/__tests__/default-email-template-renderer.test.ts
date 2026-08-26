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

  it('renders existingAccountSignUp without naming it a password reset', () => {
    const result = renderer.render(
      'existingAccountSignUp',
      { otp: '123456', email: 'test@example.com' },
      'en',
    );

    expect(result.subject).toBe('You already have an account');
    expect(result.body).toContain('123456');
    // The whole point of the separate key: a player who never asked to reset anything
    // must not be handed a bare reset code with no explanation.
    expect(result.body).toContain('no new account was created');
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
