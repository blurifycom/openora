import { readFileSync } from 'node:fs';
import * as z from 'zod';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadExtensions } from '@openora/core/server';
import { setupTestDb, bootTestApp, type TestDb, type TestApp } from '../index.js';

const ServiceExampleSchema = z.object({ name: z.string(), manifest: z.array(z.string()).min(1) });
const createServiceExample = ServiceExampleSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../../tools/create/service-example.json', import.meta.url), 'utf8'),
  ),
);
const SUGGESTED_MANIFEST = /^Add them: SERVICE_MANIFEST=(\S+)$/m;
const SPLIT_ENV = ['SERVICE_MANIFEST', 'SERVICE_NAME'] as const;

let db: TestDb;
let split: TestApp;

/** Boots every installed module under `manifest`, as a split service named `split-e2e`. */
async function bootSplit(manifest: string) {
  const saved = SPLIT_ENV.map((key) => [key, process.env[key]] as const);
  process.env['SERVICE_MANIFEST'] = manifest;
  process.env['SERVICE_NAME'] = 'split-e2e';
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

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

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
    expect((await split.app.request('/compliance/country-rules')).status).toBe(401);
    expect((await split.app.request('/cms/pages')).status).toBe(404);
  });

  it('is the manifest the first boot of SERVICE_MANIFEST=wallet tells to use', async () => {
    const refusal = await bootSplit('wallet').then(
      async (booted) => {
        await booted.close();
        return 'SERVICE_MANIFEST=wallet booted';
      },
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    expect(refusal).toMatch(/- identity \(required by wallet/);
    expect(refusal).toMatch(/- wallet runs without RG_LIMITS \(bound by compliance\)/);
    expect(refusal).toMatch(/- identity requires MAIL_DISPATCH \(bound by mail\)/);
    expect(SUGGESTED_MANIFEST.exec(refusal)?.[1]).toBe(createServiceExample.manifest.join(','));
  });
});
