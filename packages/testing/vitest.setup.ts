// Same reason as packages/core/vitest.setup.ts: these suites boot the whole app and
// deliberately drive error paths, so the default log level buries a real failure under
// serialized pino errors. Set LOG_LEVEL yourself to get the output back for one run.
process.env['LOG_LEVEL'] ??= 'silent';

// Secrets every booted app reads at composition time (loadExtensions / createApp).
process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
process.env['NODE_ENV'] ??= 'test';
