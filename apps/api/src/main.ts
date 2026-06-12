import { createApp } from '@oss/api-runtime';
import { contract } from '@oss/orpc-contract';
import { loadExtensions } from './extensions.js';
import { withPremiumContracts } from './editions.js';

async function bootstrap() {
  const plugins = await loadExtensions();

  const { listen, emitOpenApiSpec } = await createApp({
    plugins,
    // Core contract + the premium slices this edition enables (OSS_PREMIUM). The
    // free edition emits OpenAPI for core only. See editions.ts / ADR-0019.
    contract: withPremiumContracts(contract),
    openapi: { info: { title: 'OSS Igaming API', version: '0.0.1' } },
  });

  await listen();
  await emitOpenApiSpec();
}

bootstrap();
