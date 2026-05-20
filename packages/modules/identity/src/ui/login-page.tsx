import { useState, type FormEvent } from 'react';
import type { UIProvider } from '@oss/ui-provider-contract';

interface LoginPageProps {
  ui: UIProvider;
  onSuccess?: (token: string) => void;
  onRegisterClick?: () => void;
}

export function LoginPage({ ui, onSuccess, onRegisterClick }: LoginPageProps) {
  const { Button, Input, Card } = ui;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setLoading(true);
    try {
      const res = await fetch('/identity/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { message?: string };
        throw new Error(body.message ?? 'Login failed');
      }
      const data = (await res.json()) as { session: { token: string } };
      onSuccess?.(data.session.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <form onSubmit={handleSubmit}>
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Input
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error}
          required
        />
        <Button type="submit" loading={loading}>
          Sign in
        </Button>
        {onRegisterClick && (
          <Button type="button" variant="ghost" onClick={onRegisterClick}>
            Create account
          </Button>
        )}
      </form>
    </Card>
  );
}
