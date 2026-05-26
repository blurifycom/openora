import { createApp } from '@oss/api-runtime';
import { contract } from '@oss/orpc-contract';
import { loadExtensions } from './extensions.js';

async function bootstrap() {
  const plugins = await loadExtensions();

  const { listen, emitOpenApiSpec } = await createApp({
    plugins,
    contract,
    openapi: { info: { title: 'OSS Igaming API', version: '0.0.1' } },
  });

  await listen();
  await emitOpenApiSpec();
}

bootstrap();
