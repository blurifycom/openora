/**
 * Thin API helpers for E2E - direct calls to the platform API, bypassing the
 * browser session for setup/verification. Mirrors the helper style consumers use.
 */
const API = process.env['API_URL'] ?? 'http://localhost:3001';

export { API };

export const SEED = {
  adminEmail: 'admin@oss.dev',
  adminPassword: 'password123',
  // seedDemoData creates players player.1@demo.igaming.dev .. with this password
  playerEmail: 'player.1@demo.igaming.dev',
  playerPassword: 'password123',
} as const;

export interface LoginResult {
  userId: string;
  cookie: string;
}

export async function apiLogin(email: string, password: string): Promise<LoginResult> {
  const res = await fetch(`${API}/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { user: { id: string } };
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return { userId: data.user.id, cookie };
}

export async function apiBalance(userId: string): Promise<{ balance: number; currency: string }> {
  const res = await fetch(`${API}/wallet/balance`, { headers: { 'x-user-id': userId } });
  if (!res.ok) throw new Error(`balance ${res.status}`);
  return res.json() as Promise<{ balance: number; currency: string }>;
}
