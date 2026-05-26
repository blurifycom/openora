import 'reflect-metadata';
import { createApp } from '@oss/api-runtime';
import { contract } from '@oss/orpc-contract';
import { defineIgamingConfig } from '@oss/shared-schemas';
import { extensions } from './extensions.config.js';

// Declarative igaming config. defineIgamingConfig validates the shape at the boundary
// and throws a precise, path-pointed error if anything is wrong - fail fast instead of
// a deep runtime surprise. createApp injects this app-wide via the IGAMING_CONFIG token,
// so services and adapters can read it. See packages/contracts/shared-schemas/src/igaming-config.ts.
const igaming = defineIgamingConfig({
  branding: {
    name: 'Minimal Igaming',
    themePreset: 'midnightSapphire', // a key from @oss/react-sdk themePresets
    supportEmail: 'support@minimal.example',
  },
  currencies: ['EUR', 'USD'], // first entry is the default currency
  jurisdictions: ['DE', 'GB'], // licensed markets
  blockedCountries: ['US', 'FR'], // geo-blocked regardless of licensing
  limits: {
    maxDepositPerDay: 1000,
    maxStakePerBet: 100,
    sessionReminderMinutes: 60,
  },
  providers: {
    // The operator's own label for the PaymentAdapter impl registered in a plugin.
    // The platform resolves the actual binding via the PAYMENT_ADAPTER DI token; this
    // string is just the documented selection (see docs/CATALOG.md > adapters).
    payment: 'stripe',
  },
});

async function bootstrap() {
  const { listen, emitOpenApiSpec } = await createApp({
    plugins: extensions, // the consumer's own plugin registry
    contract, // the OSS root contract (pass a composed one if you extend it)
    igaming, // injected via IGAMING_CONFIG
    port: Number(process.env['PORT'] ?? 3001),
    cors: { origins: process.env['CORS_ORIGINS']?.split(',') ?? '*' },
    openapi: {
      info: { title: 'Minimal Igaming API', version: '0.1.0' },
    },
  });

  await listen(); // start the HTTP server
  await emitOpenApiSpec(); // write docs/openapi.json
}

void bootstrap();
