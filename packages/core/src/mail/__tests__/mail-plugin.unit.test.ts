import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_QUEUE, MAIL_RECIPIENT_DIRECTORY } from '@openora/core/contracts';
import { Container, ModuleRegistryImpl } from '@openora/core/server';
import type { CoreTokenCatalog } from '@openora/core/server';
import plugin from '../plugin.js';

async function mailRouter(noRoutes: boolean) {
  const container = new Container();
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  if (noRoutes) {
    registry.requireOnly('mail');
  }
  registry.setOwner('mail');
  await plugin.register(registry);
  registry.setOwner(null);
  container.register(JOB_QUEUE, () => ({}) as never);
  container.register(MAIL_RECIPIENT_DIRECTORY, () => ({}) as never);
  return () => registry.routers.getAll().get('mail')?.(container);
}

describe('mail with the stdout sender in production', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_SECRET', 'a'.repeat(64));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses to boot where it serves mail', async () => {
    const build = await mailRouter(false);

    expect(build).toThrow('no EMAIL_SENDER overlay bound');
  });

  it('boots where it is loaded for its ports only', async () => {
    const build = await mailRouter(true);

    expect(build).not.toThrow();
  });
});
