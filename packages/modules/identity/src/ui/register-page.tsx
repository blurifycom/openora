import { useState, type FormEvent } from 'react';
import type { UIProvider } from '@oss/ui-provider-contract';

interface RegisterPageProps {
  ui: UIProvider;
  onSuccess?: () => void;
  onLoginClick?: () => void;
}

export function RegisterPage({ ui, onSuccess, onLoginClick }: RegisterPageProps) {
  const { Button, Input, Card } = ui;
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setLoading(true);
    try {
      const res = await fetch('/identity/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { message?: string };
        throw new Error(body.message ?? 'Registration failed');
      }
      onSuccess?.();
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
          label="Name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
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
          minLength={8}
        />
        <Button type="submit" loading={loading}>
          Create account
        </Button>
        {onLoginClick && (
          <Button type="button" variant="ghost" onClick={onLoginClick}>
            Already have an account? Sign in
          </Button>
        )}
      </form>
    </Card>
  );
}
