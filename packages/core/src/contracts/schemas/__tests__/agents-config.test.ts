import { describe, expect, it } from 'vitest';
import { AgentsConfigSchema } from '../agents.js';
import { definePlatformConfig } from '../platform-config.js';

const SONNET = 'openrouter/anthropic/claude-sonnet-4.5';
const LLAMA_FREE = 'openrouter/meta-llama/llama-3.3-70b-instruct:free';

const capabilities = {
  tools: true,
  structuredOutputs: true,
  reasoning: false,
  cacheMode: 'implicit',
} as const;

const model = (id: string, fallbacks: string[] = []) => ({
  id,
  stepTimeoutMs: 30_000,
  fallbacks,
  capabilities,
});

const issuePaths = (input: unknown) => {
  const result = AgentsConfigSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('AgentsConfigSchema model ids', () => {
  it.each([SONNET, LLAMA_FREE])('accepts the gateway id %s', (id) => {
    expect(issuePaths({ models: [model(id)] })).toEqual([]);
  });

  it.each(['anthropic/claude-sonnet-4.5', 'openrouter/anthropic', 'claude-sonnet-4.5'])(
    'rejects %s, which does not name <gateway>/<vendor>/<model>',
    (id) => {
      expect(issuePaths({ models: [model(id)] })).toEqual(['models.0.id']);
    },
  );

  it('rejects a gateway that is not configured, openrouter being the only default', () => {
    expect(issuePaths({ models: [model('direct/anthropic/claude-sonnet-4.5')] })).toEqual([
      'models.0.id',
    ]);
  });

  it('accepts a gateway the operator added', () => {
    expect(
      issuePaths({
        modelGateways: ['openrouter', 'direct'],
        models: [model('direct/anthropic/claude-sonnet-4.5')],
      }),
    ).toEqual([]);
  });
});

describe('AgentsConfigSchema fallbacks', () => {
  it('accepts a fallback to another configured model', () => {
    expect(issuePaths({ models: [model(SONNET, [LLAMA_FREE]), model(LLAMA_FREE)] })).toEqual([]);
  });

  it('rejects a fallback that is not a configured model', () => {
    expect(issuePaths({ models: [model(SONNET, [LLAMA_FREE])] })).toEqual(['models.0.fallbacks.0']);
  });

  it('rejects a model that falls back to itself', () => {
    expect(issuePaths({ models: [model(SONNET, [SONNET])] })).toEqual(['models.0.fallbacks.0']);
  });

  it('rejects a model id configured twice', () => {
    expect(issuePaths({ models: [model(SONNET), model(SONNET)] })).toEqual(['models.1.id']);
  });
});

describe('PlatformConfig.agents', () => {
  it('applies the run limits and retention defaults when agents is absent', () => {
    expect(definePlatformConfig({}).agents).toEqual({
      limits: {
        maxStepsPerRun: 10,
        maxToolCallsPerRun: 20,
        runTimeoutMs: 300_000,
        maxRunsPerAgentPerDay: 500,
      },
      retention: { runDays: 30, proposalDays: 365 },
      modelGateways: ['openrouter'],
      models: [],
      mcp: {
        enabled: false,
        path: '/mcp',
        personalFields: 'drop',
        tokenTtlDays: { default: 30, max: 90 },
        rateLimit: { perMinute: 60, perDay: 2_000, perIpPerMinute: 300 },
        tokenIssuance: { maxActivePerAdmin: 5, perHour: 10 },
        allowedOrigins: [],
        allowedHosts: [],
      },
    });
  });

  it('names the offending path when a model id bypasses the gateway', () => {
    expect(() =>
      definePlatformConfig({
        agents: { models: [{ id: 'anthropic/claude', stepTimeoutMs: 30_000, capabilities }] },
      }),
    ).toThrow(/agents\.models\.0\.id: must be a <gateway>\/<vendor>\/<model> id/);
  });
});

describe('AgentsConfigSchema mcp transport', () => {
  const mcpIssuePaths = (mcp: unknown) => issuePaths({ mcp });

  it('accepts a bound transport', () => {
    expect(
      mcpIssuePaths({
        enabled: true,
        path: '/agents/mcp',
        allowedHosts: ['backoffice.example.com'],
        allowedOrigins: ['https://backoffice.example.com'],
      }),
    ).toEqual([]);
  });

  it('lowercases an allowed host', () => {
    const parsed = AgentsConfigSchema.parse({ mcp: { allowedHosts: ['BackOffice.Example.com'] } });
    expect(parsed.mcp.allowedHosts).toEqual(['backoffice.example.com']);
  });

  it.each([
    [{ tokenTtlDays: { default: 91 } }, 'mcp.tokenTtlDays.default'],
    [{ tokenTtlDays: { max: 366 } }, 'mcp.tokenTtlDays.max'],
    [{ rateLimit: { perMinute: 3_000 } }, 'mcp.rateLimit.perMinute'],
    [{ path: 'mcp' }, 'mcp.path'],
    [{ path: '/MCP' }, 'mcp.path'],
    [{ allowedOrigins: ['https://backoffice.example.com/'] }, 'mcp.allowedOrigins.0'],
    [{ allowedHosts: ['backoffice.example.com:8443'] }, 'mcp.allowedHosts.0'],
    [{ personalFields: 'mask' }, 'mcp.personalFields'],
    [{ enabled: true }, 'mcp.allowedHosts'],
    [{ tokenIssuance: { maxActivePerAdmin: 51 } }, 'mcp.tokenIssuance.maxActivePerAdmin'],
  ])('rejects %j at %s', (mcp, path) => {
    expect(mcpIssuePaths(mcp)).toEqual([path]);
  });
});
