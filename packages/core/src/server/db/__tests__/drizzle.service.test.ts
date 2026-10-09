import { describe, it, expect, afterEach, vi } from 'vitest';
import { DrizzleService, parseReplicaUrls } from '../drizzle.service.js';

// Unreachable but valid urls: pg pools connect lazily, so nothing here touches a DB.
const PRIMARY_URL = 'postgres://u:p@127.0.0.1:1/primary';
const REPLICA_URLS = 'postgres://u:p@127.0.0.1:1/r1, postgres://u:p@127.0.0.1:1/r2';

const replicaCount = (db: object): number =>
  '$replicas' in db && Array.isArray(db.$replicas) ? db.$replicas.length : 0;

describe('DrizzleService', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('falls back to the primary for replica reads when no replica is configured', async () => {
    vi.stubEnv('DATABASE_URL', PRIMARY_URL);
    vi.stubEnv('DATABASE_REPLICA_URLS', '');
    const svc = new DrizzleService();

    expect(svc.replica).toBe(svc.db);
    await svc.dispose();
  });

  it('keeps db on the primary and routes replica reads across every replica', async () => {
    vi.stubEnv('DATABASE_URL', PRIMARY_URL);
    vi.stubEnv('DATABASE_REPLICA_URLS', REPLICA_URLS);
    const svc = new DrizzleService();

    expect(replicaCount(svc.db)).toBe(0);
    expect(replicaCount(svc.replica)).toBe(2);
    await svc.dispose();
  });
});

describe('parseReplicaUrls', () => {
  it('splits, trims and drops empty entries', () => {
    expect(parseReplicaUrls(undefined)).toEqual([]);
    expect(parseReplicaUrls(' a , ,b ')).toEqual(['a', 'b']);
  });
});
