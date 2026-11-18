import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedLocalData } from '../seed-local.js';

const admin = { email: 'admin@oss.dev', password: 'password1234' };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('seedLocalData guard', () => {
  it('refuses a non-local database host before connecting', async () => {
    await expect(
      seedLocalData({ databaseUrl: 'postgresql://u:p@db.example.com:5432/app', admin }),
    ).rejects.toThrow(/db\.example\.com/);
  });

  it('refuses a remote host passed as the host query parameter', async () => {
    await expect(
      seedLocalData({
        databaseUrl: 'postgresql://u:p@localhost/app?host=/cloudsql/proj:region:inst',
        admin,
      }),
    ).rejects.toThrow(/cloudsql/);
  });

  it('refuses NODE_ENV=production even for a local host', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(
      seedLocalData({ databaseUrl: 'postgresql://u:p@localhost:5432/app', admin }),
    ).rejects.toThrow(/production/);
  });
});
