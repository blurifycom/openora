import * as z from 'zod';

/**
 * `<gateway>/<vendor>/<model>`. The gateway prefix is mandatory: an agent SDK can route a bare
 * model id to a different gateway than the one the operator chose.
 */
export const AGENT_MODEL_ID_PATTERN =
  /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const DEFAULT_AGENT_MODEL_GATEWAYS = ['openrouter'] as const;

export const AgentModelGatewaySchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lowercase gateway slug');

export const AGENT_MODEL_CACHE_MODES = ['none', 'implicit', 'explicit'] as const;
export const AgentModelCacheModeSchema = z.enum(AGENT_MODEL_CACHE_MODES);
export type AgentModelCacheMode = z.infer<typeof AgentModelCacheModeSchema>;

export const AgentModelIdSchema = z
  .string()
  .max(128)
  .regex(AGENT_MODEL_ID_PATTERN, 'must be a <gateway>/<vendor>/<model> id');

export const AgentModelCapabilitiesSchema = z
  .object({
    tools: z.boolean(),
    structuredOutputs: z.boolean(),
    reasoning: z.boolean(),
    cacheMode: AgentModelCacheModeSchema,
  })
  .strict();

export const AgentModelSchema = z
  .object({
    id: AgentModelIdSchema,
    stepTimeoutMs: z.number().int().min(1_000).max(600_000),
    fallbacks: z.array(AgentModelIdSchema).max(5).default([]),
    capabilities: AgentModelCapabilitiesSchema,
    deprecatedOn: z.iso.date().optional(),
  })
  .strict();

export const AgentsConfigSchema = z
  .object({
    limits: z
      .object({
        maxStepsPerRun: z.number().int().min(1).max(50).default(10),
        maxToolCallsPerRun: z.number().int().min(1).max(100).default(20),
        runTimeoutMs: z.number().int().min(1_000).max(900_000).default(300_000),
        maxRunsPerAgentPerDay: z.number().int().min(1).max(100_000).default(500),
      })
      .strict()
      .prefault({}),
    retention: z
      .object({
        runDays: z.number().int().min(1).max(3650).default(30),
        proposalDays: z.number().int().min(1).max(3650).default(365),
      })
      .strict()
      .prefault({}),
    /** Gateways a model id may name as its first segment. */
    modelGateways: z
      .array(AgentModelGatewaySchema)
      .min(1)
      .max(10)
      .default([...DEFAULT_AGENT_MODEL_GATEWAYS]),
    models: z.array(AgentModelSchema).max(50).default([]),
  })
  .strict()
  .superRefine((config, ctx) => {
    const gateways = new Set(config.modelGateways);
    const configuredIds = new Set(config.models.map((model) => model.id));
    const seenIds = new Set<string>();
    config.models.forEach((model, modelIndex) => {
      if (seenIds.has(model.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `model id "${model.id}" is configured more than once`,
          path: ['models', modelIndex, 'id'],
        });
      }
      seenIds.add(model.id);
      const [gateway = ''] = model.id.split('/');
      if (AGENT_MODEL_ID_PATTERN.test(model.id) && !gateways.has(gateway)) {
        ctx.addIssue({
          code: 'custom',
          message: `gateway "${gateway}" is not in agents.modelGateways`,
          path: ['models', modelIndex, 'id'],
        });
      }
      model.fallbacks.forEach((fallback, fallbackIndex) => {
        const path = ['models', modelIndex, 'fallbacks', fallbackIndex];
        if (fallback === model.id) {
          ctx.addIssue({ code: 'custom', message: 'a model cannot fall back to itself', path });
          return;
        }
        if (!configuredIds.has(fallback)) {
          ctx.addIssue({
            code: 'custom',
            message: `fallback "${fallback}" is not a configured model`,
            path,
          });
        }
      });
    });
  });

export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
