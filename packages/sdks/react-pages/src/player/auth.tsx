'use client';

import { useState, type FormEvent } from 'react';
import {
  useNavigate,
  useRequestPasswordReset,
  useResetPassword,
  useSearchParam,
  useUI,
} from '@oss/react-hooks';

function errorOf(e: unknown): string | undefined {
  return e instanceof Error ? e.message : undefined;
}

export function ForgotPasswordPage({
  title = 'Reset your password',
  subtitle = 'Enter your account email and we will send a reset link.',
  loginHref = '/login',
}: {
  title?: string;
  subtitle?: string;
  loginHref?: string;
}) {
  const { Card, Input, Button } = useUI();
  const request = useRequestPasswordReset();
  const [email, setEmail] = useState('');

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    try {
      await request.mutateAsync({ email });
    } catch {
      // surfaced via request.error
    }
  };

  return (
    <div className="auth-screen">
      <Card className="auth-screen__card">
        <h1 className="auth-screen__title">{title}</h1>
        <p className="auth-screen__subtitle">{subtitle}</p>
        {request.isSuccess ? (
          <p className="auth-screen__hint">
            If an account exists for <strong>{email}</strong>, a reset link is on its way.
          </p>
        ) : (
          <form className="auth-screen__form" onSubmit={onSubmit}>
            <Input
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            {errorOf(request.error) && (
              <div className="auth-screen__error">{errorOf(request.error)}</div>
            )}
            <Button type="submit" loading={request.isPending}>
              Send reset link →
            </Button>
          </form>
        )}
        <div className="auth-screen__hint">
          Remembered it? <a href={loginHref}>Back to sign in</a>
        </div>
      </Card>
    </div>
  );
}

export function ResetPasswordPage({
  title = 'Choose a new password',
  redirectTo = '/login',
}: {
  title?: string;
  redirectTo?: string;
}) {
  const navigate = useNavigate();
  const token = useSearchParam('token') ?? '';
  const { Card, Input, Button } = useUI();
  const reset = useResetPassword();
  const [newPassword, setNewPassword] = useState('');

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    try {
      await reset.mutateAsync({ token, newPassword });
      navigate.replace(redirectTo);
    } catch {
      // surfaced via reset.error
    }
  };

  return (
    <div className="auth-screen">
      <Card className="auth-screen__card">
        <h1 className="auth-screen__title">{title}</h1>
        {token ? (
          <form className="auth-screen__form" onSubmit={onSubmit}>
            <Input
              label="New password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={8}
              required
            />
            {errorOf(reset.error) && (
              <div className="auth-screen__error">{errorOf(reset.error)}</div>
            )}
            <Button type="submit" loading={reset.isPending}>
              Update password →
            </Button>
          </form>
        ) : (
          <p className="auth-screen__error">Missing or invalid reset token.</p>
        )}
      </Card>
    </div>
  );
}
