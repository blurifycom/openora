export { RedisPubSubRealtimeTransport, SseClientAuthorizer } from '@openora/core/server';
export {
  runRealtimeTransportConformanceSuite,
  type RealtimeTransportHarness,
} from './realtime-transport-conformance.js';
export {
  createTestDb,
  createTestRedis,
  redisUrlForWorker,
  waitForConsumerGroup,
  type Migration,
  type TestDb,
  type TestRedis,
} from './real-infra.js';
export {
  seedUser,
  seedPlayerWithUser,
  uniqueUsername,
  type SeedPlayerOverrides,
} from './seed-player.js';
export { seedCompletedDeposit } from './seed-wallet.js';
// Tests build a kernel over a module's own registrations; production code reaches it only
// through MCP_KERNEL, which createApp binds.
export {
  createMcpKernel,
  type McpAuthorization,
  type McpAuthorizer,
  type McpKernelDeps,
} from '../server/mcp/index.js';
