import { main } from '../dist/server/db/outbox/replay.js';

process.exitCode = await main(process.argv.slice(2), process.env);
