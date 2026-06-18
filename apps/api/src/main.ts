import { createApp } from '@oss/core/server';
import { user, session, account, verification, twoFactor } from '@oss/core/pam/schema/identity';
import { loadExtensions } from './extensions.js';
import { buildContract } from './editions.js';

async function bootstrap() {
  const plugins = await loadExtensions();

  const { listen, emitOpenApiSpec } = await createApp({
    plugins,
    // health + core slices + the add-on slices this edition enables (OSS_ADDONS).
    // Composed here in the consumer's root - the single aggregation point. The
    // default build emits OpenAPI for core only. See editions.ts / ADR-0019.
    contract: buildContract(),
    // The engine is domain-agnostic: the consumer injects its PAM identity tables
    // for session verification. See ADR-0025.
    authSchema: { user, session, account, verification, twoFactor },
    openapi: { info: { title: 'OSS Igaming API', version: '0.0.1' } },
  });

  await listen();
  await emitOpenApiSpec();
}

bootstrap();
