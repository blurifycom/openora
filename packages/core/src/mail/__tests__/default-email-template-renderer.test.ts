import { describe, it, expect } from 'vitest';
import type { MailTemplate } from '@openora/core/contracts';
import { DefaultEmailTemplateRenderer } from '../adapters/default-email-template-renderer.js';

describe('DefaultEmailTemplateRenderer', () => {
  const renderer = new DefaultEmailTemplateRenderer();

  it('renders the verifyEmail template with the otp interpolated', () => {
    const result = renderer.render({ key: 'verifyEmail', data: { otp: '123456' } }, 'de');

    expect(result.subject).toBe('Verify your email');
    expect(result.text).toBe('Your email verification code is: 123456');
    expect(result.html).toContain('123456');
    expect(result.html).toMatch(/^<p>/);
  });

  it('renders the resetPasswordOtp template with the otp interpolated', () => {
    const result = renderer.render(
      { key: 'resetPasswordOtp', data: { otp: '123456', email: 'test@example.com' } },
      'fr',
    );

    expect(result.subject).toBe('Reset your password');
    expect(result.text).toBe('Your password reset code is: 123456');
  });

  it('renders an admin-reset template that identifies its origin', () => {
    const result = renderer.render(
      { key: 'adminResetPasswordOtp', data: { otp: '123456', email: 'test@example.com' } },
      'en',
    );

    expect(result.subject).toContain('administrator');
    expect(result.text).toContain('123456');
  });

  it('renders existingAccountSignUp without naming it a password reset', () => {
    const result = renderer.render(
      { key: 'existingAccountSignUp', data: { otp: '123456', email: 'test@example.com' } },
      'en',
    );

    expect(result.subject).toBe('You already have an account');
    expect(result.text).toContain('123456');
    expect(result.text).toContain('no new account was created');
  });

  it('renders every template key with a non-empty subject, markup-free text and an HTML body', () => {
    const samples: MailTemplate[] = [
      { key: 'verifyEmail', data: { otp: '111111' } },
      { key: 'resetPasswordOtp', data: { otp: '111111', email: 'a@b.com' } },
      { key: 'adminResetPasswordOtp', data: { otp: '111111', email: 'a@b.com' } },
      { key: 'existingAccountSignUp', data: { otp: '111111', email: 'a@b.com' } },
      {
        key: 'rgLimitUpdated',
        data: {
          period: 'daily',
          type: 'deposit',
          amount: '100.00',
          currency: 'EUR',
          minutes: null,
        },
      },
      { key: 'rgCoolingOffActivated', data: { expiresAt: '2026-01-01T00:00:00.000Z' } },
      { key: 'rgCoolingOffLifted', data: {} },
      { key: 'rgSelfExclusionActivated', data: { expiresAt: null, isPermanent: true } },
      { key: 'rgSelfExclusionLifted', data: {} },
      {
        key: 'withdrawalApproved',
        data: {
          amount: '100.00',
          currency: 'USDT',
          transactionId: '00000000-0000-0000-0000-000000000000',
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
      },
      {
        key: 'withdrawalRejected',
        data: {
          amount: '100.00',
          currency: 'USDT',
          transactionId: '00000000-0000-0000-0000-000000000000',
          occurredAt: '2026-01-01T00:00:00.000Z',
          reason: 'AML review',
        },
      },
      { key: 'kycResubmissionRequested', data: { reason: null } },
      { key: 'adminInvitation', data: { token: 'tok', expiresAt: '2026-01-01T00:00:00.000Z' } },
    ];

    for (const template of samples) {
      const result = renderer.render(template, 'en');
      expect(result.subject.length).toBeGreaterThan(0);
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.text).not.toMatch(/<[a-z/]/i);
      expect(result.html).toContain('<p>');
    }
  });

  it('groups the withdrawal amount in thousands, matching the in-app notification', () => {
    const result = renderer.render(
      {
        key: 'withdrawalApproved',
        data: {
          amount: '10000.00',
          currency: 'USDT',
          transactionId: '00000000-0000-0000-0000-000000000000',
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
      },
      'en',
    );

    expect(result.text).toContain('10,000 USDT');
  });

  it('composes the rgLimitUpdated sentence from raw amount/currency, grouped', () => {
    const money = renderer.render(
      {
        key: 'rgLimitUpdated',
        data: {
          period: 'daily',
          type: 'deposit',
          amount: '10000.00',
          currency: 'EUR',
          minutes: null,
        },
      },
      'en',
    );
    expect(money.text).toContain('10,000 EUR');

    const session = renderer.render(
      {
        key: 'rgLimitUpdated',
        data: { period: 'session', type: 'session', amount: null, currency: null, minutes: 60 },
      },
      'en',
    );
    expect(session.text).toContain('60 minutes');
  });

  it('falls back to a default locale instead of throwing on an unparseable tag', () => {
    const render = () =>
      renderer.render(
        { key: 'rgCoolingOffActivated', data: { expiresAt: '2026-03-09T15:30:00.000Z' } },
        'en_US',
      );

    expect(render).not.toThrow();
    expect(render().text).toContain('2026');
  });

  it('formats the cooling-off date against the recipient locale', () => {
    const en = renderer.render(
      { key: 'rgCoolingOffActivated', data: { expiresAt: '2026-03-09T15:30:00.000Z' } },
      'en-GB',
    );
    const de = renderer.render(
      { key: 'rgCoolingOffActivated', data: { expiresAt: '2026-03-09T15:30:00.000Z' } },
      'de-DE',
    );

    expect(en.text).not.toBe(de.text);
  });
});
