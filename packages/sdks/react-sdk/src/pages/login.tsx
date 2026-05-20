'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useLogin } from '../hooks/auth.js';
import { useUI } from '../ui-provider.js';

export function LoginPage({
  title = 'Sign in',
  eyebrow = 'Operator Terminal',
  subtitle = 'Restricted access. Credentials verified against the platform identity service.',
  redirectTo = '/',
}: {
  title?: string;
  eyebrow?: string;
  subtitle?: string;
  redirectTo?: string;
}) {
  const router = useRouter();
  const { Card, Input, Button } = useUI();
  const login = useLogin();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    try {
      await login.mutateAsync({ email, password });
      router.replace(redirectTo);
    } catch {
      // surfaced via login.error
    }
  };

  const errorMsg = login.error instanceof Error ? login.error.message : undefined;

  return (
    <div className="auth-screen">
      <Card className="auth-screen__card">
        <div className="auth-screen__eyebrow">{eyebrow}</div>
        <h1 className="auth-screen__title">{title}</h1>
        <p className="auth-screen__subtitle">{subtitle}</p>

        <form className="auth-screen__form" onSubmit={onSubmit}>
          <Input
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Input
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {errorMsg && <div className="auth-screen__error">{errorMsg}</div>}
          <Button type="submit" loading={login.isPending}>
            Continue →
          </Button>
        </form>

        <div className="auth-screen__hint">
          Need an account? Provision via the platform API:
          <br />
          <code>POST /identity/register</code>
        </div>
      </Card>
    </div>
  );
}
