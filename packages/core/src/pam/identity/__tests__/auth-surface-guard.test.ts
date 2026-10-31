import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { GEO_CHECK_COMMANDS, KYC_ADAPTER, MAIL_DISPATCH } from '@openora/core/contracts';
import { Container, loadPlugins } from '@openora/core/server';
import { mock } from '../../../testing/mock.js';

const pluginPath = fileURLToPath(new URL('../plugin.ts', import.meta.url));

async function identityRouterFactory(options: { noRoutes?: boolean } = {}) {
  const container = new Container();
  container.register(MAIL_DISPATCH, () => mock({}));
  const registry = await loadPlugins(
    [{ id: 'identity', path: pluginPath, noRoutes: options.noRoutes }],
    container,
  );
  return { container, factory: registry.routers.getAll().get('identity') };
}

describe('identity auth-surface boot guard', () => {
  beforeEach(() => {
    vi.stubEnv('WITHDRAWAL_PIN_HMAC_SECRET', 'x'.repeat(64));
    vi.stubEnv('NODE_ENV', 'production');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('refuses to mount the auth routes in production when the country gate is unbound', async () => {
    const { container, factory } = await identityRouterFactory();

    expect(() => factory?.(container as never)).toThrow(/country gate is a silent no-op/);
  });

  it('passes the guard once the gate is bound, whatever KYC adapter is bound', async () => {
    const { container, factory } = await identityRouterFactory();
    container.register(GEO_CHECK_COMMANDS, () => mock({}));

    expect(() => factory?.(container as never)).not.toThrow(/country gate/);
  });

  it('never trips when identity is service-only, its router being discarded', async () => {
    const { container, factory } = await identityRouterFactory({ noRoutes: true });

    expect(() => factory?.(container as never)).not.toThrow(/country gate/);
    expect(container.has(KYC_ADAPTER)).toBe(true);
  });
});
