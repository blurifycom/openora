import { readFileSync } from 'node:fs';
import * as z from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadExtensions } from '@openora/core/server';
import { setupTestDb, bootTestApp, type TestDb, type TestApp } from '../index.js';

const ServiceExampleSchema = z.object({ name: z.string(), manifest: z.array(z.string()).min(1) });
const createServiceExample = ServiceExampleSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../../tools/create/service-example.json', import.meta.url), 'utf8'),
  ),
);
const SUGGESTED_MANIFEST = /^Add them: SERVICE_MANIFEST=(\S+)$/m;
const SPLIT_ENV = ['SERVICE_MANIFEST', 'SERVICE_NAME', 'REALTIME_NAMESPACE'] as const;

let db: TestDb;
let split: TestApp;

async function bootSplit(manifest: string) {
  const saved = SPLIT_ENV.map((key) => [key, process.env[key]] as const);
  process.env['SERVICE_MANIFEST'] = manifest;
  process.env['SERVICE_NAME'] = 'split-e2e';
  process.env['REALTIME_NAMESPACE'] = 'split-e2e';
  try {
    return await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function refusalOf(manifest: string): Promise<string> {
  return bootSplit(manifest).then(
    async (booted) => {
      await booted.close();
      return `SERVICE_MANIFEST=${manifest} booted`;
    },
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
}

beforeAll(async () => {
  db = await setupTestDb();
  split = await bootSplit(createServiceExample.manifest.join(','));
}, 60_000);

afterAll(async () => {
  await split?.close();
  await db?.dispose();
});

describe('a split service booted from the pnpm create:service example', () => {
  it('serves its modules, guards their admin routes, and serves none it leaves out', async () => {
    expect((await split.app.request('/health')).status).toBe(200);
    expect((await split.app.request('/wallet/admin/assets')).status).toBe(401);
    expect((await split.app.request('/compliance/country-rules')).status).toBe(404);
    expect((await split.app.request('/cms/pages')).status).toBe(404);
  });

  it('is the manifest the first boot of SERVICE_MANIFEST=wallet tells to use', async () => {
    const refusal = await refusalOf('wallet');

    expect(refusal).toMatch(/- identity \(required by wallet/);
    expect(refusal).not.toMatch(/RG_LIMITS/);
    expect(refusal).toMatch(/- identity requires MAIL_DISPATCH \(bound by mail\)/);
    expect(SUGGESTED_MANIFEST.exec(refusal)?.[1]).toBe(createServiceExample.manifest.join(','));
  });

  it('refuses a wallet without the ports its withdrawal checks read, suggesting them required-only', async () => {
    const refusal = await refusalOf('wallet,identity,audit,mail');

    expect(refusal).toMatch(/- wallet requires PLAYER_TAGS \(bound by tag\)/);
    expect(SUGGESTED_MANIFEST.exec(refusal)?.[1]?.split(',')).toEqual(
      expect.arrayContaining(['tag:no-routes', 'compliance:no-routes']),
    );
  });

  it('refuses notifications without audit and suggests audit required-only', async () => {
    const refusal = await refusalOf('notifications');

    expect(refusal).toMatch(/- notifications runs without sealed:AUDIT_WRITER \(bound by audit\)/);
    expect(SUGGESTED_MANIFEST.exec(refusal)?.[1]?.split(',')).toEqual(
      expect.arrayContaining(['notifications', 'audit:no-routes']),
    );
  });
});
