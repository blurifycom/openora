import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadExtensions } from '@openora/core/server';
import {
  asAdmin,
  asPlayer,
  bootE2e,
  closeE2e,
  registerPlayer,
  type TestApp,
  type TestDb,
} from '../index.js';

let db: TestDb;
let app: TestApp;

beforeAll(async () => {
  const fixturePath = fileURLToPath(
    new URL('./fixtures/test-mcp-transport-plugin.ts', import.meta.url),
  );
  ({ db, app } = await bootE2e({
    plugins: [...(await loadExtensions()), { id: 'test-mcp-transport', path: fixturePath }],
  }));
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('MCP token policy', () => {
  it('tells an admin with MCP access whether issuing is on and the lifetime it allows', async () => {
    const admin = await asAdmin(app.app);

    const res = await admin.get('/iam/my-mcp-tokens/policy');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, ttlDays: { default: 30, max: 90 } });
  });

  it('refuses a player', async () => {
    const email = `mcp-policy-${crypto.randomUUID()}@e2e.test`;
    await registerPlayer(app, { email });
    const player = await asPlayer(app.app, { email });

    const res = await player.get('/iam/my-mcp-tokens/policy');

    expect(res.status).toBe(403);
  });
});
