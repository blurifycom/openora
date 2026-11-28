import { recordSpans } from './src/trace-recorder.js';

process.env['LOG_LEVEL'] ??= 'silent';

process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
process.env['NODE_ENV'] ??= 'test';

recordSpans();
