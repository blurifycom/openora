import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { IDENTITY_READER, JOB_QUEUE } from '@openora/core/contracts';
import { createApp, type PluginEntry } from '@openora/core/server';
import { redisUrlForWorker } from '@openora/core/testing';
import { makeIdentityReader, makeJobQueue } from '../../../testing/mock.js';

// No connection is opened on this URL: the manifest check runs before anything touches Postgres.
const DUMMY_DATABASE_URL = 'postgres://test:test@127.0.0.1:1/notifications_manifest_test';
const KEYS = ['REDIS_URL', 'SERVICE_MANIFEST', 'SERVICE_NAME', 'REALTIME_NAMESPACE'] as const;
const saved = KEYS.map((key) => [key, process.env[key]] as const);

const notifications: PluginEntry = {
  id: 'notifications',
  path: fileURLToPath(new URL('../plugin.ts', import.meta.url)),
};
const audit: PluginEntry = {
  id: 'audit',
  path: fileURLToPath(new URL('../../../audit/plugin.ts', import.meta.url)),
};

/** Boots the real notifications and audit plugins under `manifest` (none: a full boot). */
async function boot(plugins: PluginEntry[], manifest?: string) {
  process.env['REDIS_URL'] = redisUrlForWorker();
  delete process.env['SERVICE_MANIFEST'];
  delete process.env['SERVICE_NAME'];
  delete process.env['REALTIME_NAMESPACE'];
  if (manifest) {
    process.env['SERVICE_MANIFEST'] = manifest;
    process.env['SERVICE_NAME'] = 'notifications-split';
    process.env['REALTIME_NAMESPACE'] = 'notifications-split';
  }
  const created = await createApp({ plugins, databaseUrl: DUMMY_DATABASE_URL }, (c) => {
    c.register(JOB_QUEUE, () => makeJobQueue());
    // The identity module's port, which notifications reads when its router is built.
    c.register(IDENTITY_READER, () => makeIdentityReader());
  });
  await created.close();
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('notifications on a split service - the audit writer is a control it may not skip', () => {
  it('refuses a manifest that has notifications but leaves out audit, naming why', async () => {
    await expect(boot([notifications, audit], 'notifications')).rejects.toThrow(
      'SERVICE_MANIFEST=notifications leaves out what this service needs:\n' +
        '  - notifications runs without sealed:AUDIT_WRITER (bound by audit): a KYC resubmission ' +
        'notice that never reaches the mail queue goes unaudited\n' +
        'Add them: SERVICE_MANIFEST=notifications,audit:no-routes\n' +
        'A split service may not skip a control the rest of its install enforces',
    );
  });

  it('boots once the manifest has audit too', async () => {
    await expect(boot([notifications, audit], 'notifications,audit')).resolves.toBeUndefined();
  });

  it('boots the full plugin list with no manifest', async () => {
    await expect(boot([notifications, audit])).resolves.toBeUndefined();
  });
});
