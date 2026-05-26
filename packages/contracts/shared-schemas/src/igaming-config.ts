import { z } from 'zod';

// Centralized, schema-validated igaming configuration. A downstream operator
// declares one of these and passes it to `createApp({ igaming })`; it is the single
// declarative home for the things an operator (or their agent) sets to shape a
// igaming - currencies, jurisdictions, limits, provider selection, branding.
// It feeds the generated CATALOG.md so an agent can see the exact shape to fill.

export const CurrencyCodeSchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'ISO 4217 uppercase code, e.g. USD');

export const CountryCodeSchema = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 uppercase code, e.g. DE');

export const LimitsSchema = z
  .object({
    // Player-facing responsible-gaming defaults. Amounts in major units of the default currency.
    maxDepositPerDay: z.number().nonnegative().optional(),
    maxDepositPerMonth: z.number().nonnegative().optional(),
    maxLossPerDay: z.number().nonnegative().optional(),
    maxStakePerBet: z.number().nonnegative().optional(),
    sessionReminderMinutes: z.number().int().positive().optional(),
  })
  .strict();

export const ProviderSelectionSchema = z
  .object({
    // Which vendor adapter each swap seam should bind to. The string is the
    // operator's own label for the implementation they registered in a plugin;
    // the platform resolves it via the DI token. See docs/CATALOG.md > adapters.
    payment: z.string().optional(),
    kyc: z.string().optional(),
    geoIp: z.string().optional(),
    aggregator: z.string().optional(),
    notification: z.string().optional(),
  })
  .strict();

export const BrandingSchema = z
  .object({
    name: z.string().min(1),
    themePreset: z.string().optional(), // a key from @oss/react-sdk themePresets
    supportEmail: z.string().email().optional(),
  })
  .strict();

export const IgamingConfigSchema = z
  .object({
    branding: BrandingSchema,
    // Currencies the igaming transacts in; the first is the default.
    currencies: z.array(CurrencyCodeSchema).min(1),
    // Jurisdictions the igaming is licensed to operate in.
    jurisdictions: z.array(CountryCodeSchema).min(1),
    // Countries blocked regardless of licensing (geo-block list).
    blockedCountries: z.array(CountryCodeSchema).default([]),
    // Module ids to enable. Empty/omitted = all registered plugins load.
    enabledModules: z.array(z.string()).optional(),
    limits: LimitsSchema.default({}),
    providers: ProviderSelectionSchema.default({}),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (!cfg.jurisdictions.every((j) => !cfg.blockedCountries.includes(j))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A jurisdiction cannot also be in blockedCountries.',
        path: ['blockedCountries'],
      });
    }
  });

export type IgamingConfig = z.infer<typeof IgamingConfigSchema>;
export type IgamingConfigInput = z.input<typeof IgamingConfigSchema>;

/**
 * Validate and normalize a igaming config. Throws a precise, agent-legible error
 * (listing the offending path) when the config is malformed - fail-fast at the
 * boundary instead of a deep runtime surprise.
 */
export function defineIgamingConfig(config: IgamingConfigInput): IgamingConfig {
  const result = IgamingConfigSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid igaming config:\n${issues}`);
  }
  return result.data;
}

/** DI token to inject the active IgamingConfig into services/adapters. */
export const IGAMING_CONFIG = Symbol('IGAMING_CONFIG');
