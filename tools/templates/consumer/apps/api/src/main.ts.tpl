import { createApp } from '@oss/api-runtime';
import { contract } from '@oss/orpc-contract';
import { defineIgamingConfig } from '@oss/shared-schemas';
import { extensions } from './extensions.config.js';

// Declarative platform config, validated at the boundary by defineIgamingConfig.
// Injected app-wide via the IGAMING_CONFIG token so services/adapters can read it.
const igaming = defineIgamingConfig({
  branding: {
    name: '{{name}}',
    themePreset: 'midnightSapphire',
    supportEmail: 'support@{{name}}.example',
  },
  currencies: ['EUR', 'USD'],
  jurisdictions: ['DE', 'GB'],
  blockedCountries: ['US'],
  limits: {
    maxDepositPerDay: 1000,
    maxStakePerBet: 100,
    sessionReminderMinutes: 60,
  },
  providers: {
    payment: 'mock',
  },
});

async function bootstrap() {
  const { listen, emitOpenApiSpec } = await createApp({
    plugins: extensions,
    contract,
    igaming,
    port: Number(process.env['PORT'] ?? 3001),
    cors: { origins: process.env['CORS_ORIGINS']?.split(',') ?? '*' },
    openapi: { info: { title: '{{name}} API', version: '0.1.0' } },
  });

  await listen();
  await emitOpenApiSpec();
}

void bootstrap();
