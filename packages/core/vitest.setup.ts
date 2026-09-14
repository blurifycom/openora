// Tests assert on behaviour, never on log output, and several suites deliberately drive
// error paths - a passing run otherwise prints hundreds of serialized pino errors and
// buries the one line that matters when something does fail. A suite that cares about
// logging mocks the logger module and is unaffected by the level.
//
// Set LOG_LEVEL yourself to get the output back for one run:
//   LOG_LEVEL=debug pnpm -F @openora/core test:integration
process.env['LOG_LEVEL'] ??= 'silent';
