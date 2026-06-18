import { createApp } from '@oss/core/server';
// for session verification. See ADR-0025.
import { user, session, account, verification, twoFactor } from '@oss/core/pam/schema/identity';
import { loadExtensions } from './extensions.js';
import { buildContract } from './editions.js';

async function bootstrap() {
  const plugins = await loadExtensions();

  const { listen, emitOpenApiSpec } = await createApp({
    plugins,
    contract: buildContract(),
    authSchema: { user, session, account, verification, twoFactor },
    openapi: { info: { title: 'OSS Igaming API', version: '0.0.1' } },
  });

  await listen();
  // Default build emits OpenAPI for core only. See editions.ts / ADR-0019.
  await emitOpenApiSpec();
}

bootstrap();
