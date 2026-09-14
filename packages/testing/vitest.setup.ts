// Same reason as packages/core/vitest.setup.ts: these suites boot the whole app and
// deliberately drive error paths, so the default log level buries a real failure under
// serialized pino errors. Set LOG_LEVEL yourself to get the output back for one run.
process.env['LOG_LEVEL'] ??= 'silent';
