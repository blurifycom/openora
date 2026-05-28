import { z } from 'zod';

/**
 * Platform-wide T0 configuration consumed by the slot evaluation context and
 * plugin gating (see ADR-0013, Tier 0). This is the "config-only customization"
 * surface - operators (or compliance) toggle behavior without writing code.
 *
 * v1 ships a Zod schema + a file loader (YAML / JSON). The admin UI for editing
 * this config is deferred to v2.
 *
 * Distinct from `IgamingConfig` (currencies / jurisdictions / vendor selection)
 * which lives in `igaming-config.ts`. PlatformConfig is specifically about the
 * extension surface: which feature flags are on, which brand is active, RG
 * defaults per geo.
 */

export const FeatureFlagsSchema = z.record(z.string(), z.boolean());

export const BrandSchema = z
  .object({
    /** Stable id used in slot `brandScope` and theme lookup. */
    id: z.string().min(1),
    name: z.string().min(1),
    /** A daisyUI theme name or a key from `themePresets`. */
    themePreset: z.string().optional(),
    /** Brand-specific override map for the `--bo-*` CSS variables. */
    themeOverrides: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const PlatformConfigSchema = z
  .object({
    /**
     * Feature flag map. Slot fills with `featureFlag: 'X'` render only when
     * `features.X` is true.
     */
    features: FeatureFlagsSchema.default({}),
    /**
     * Brand definitions for multi-brand operators. Empty means single-brand
     * mode - slot fills with `brandScope` are evaluated against `null` brand
     * and therefore hidden (unless `brandScope` is also omitted).
     */
    brands: z.array(BrandSchema).default([]),
    /**
     * Id of the currently active brand (matched against `brands[*].id`). When
     * unset, slot fills with `brandScope` do not match - operator must seed
     * this from request context / session in multi-brand mode.
     */
    activeBrand: z.string().optional(),
    /**
     * RG default limits per ISO 3166-1 alpha-2 country code. Each entry mirrors
     * the LimitsSchema but at the platform-config level (jurisdiction defaults).
     */
    rgLimits: z
      .record(
        z.string().length(2),
        z
          .object({
            maxDepositPerDay: z.number().nonnegative().optional(),
            maxDepositPerMonth: z.number().nonnegative().optional(),
            maxLossPerDay: z.number().nonnegative().optional(),
            maxStakePerBet: z.number().nonnegative().optional(),
            sessionReminderMinutes: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .default({}),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.activeBrand && !cfg.brands.some((b) => b.id === cfg.activeBrand)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `activeBrand "${cfg.activeBrand}" does not match any brands[*].id`,
        path: ['activeBrand'],
      });
    }
  });

export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;
export type PlatformConfigInput = z.input<typeof PlatformConfigSchema>;

/**
 * Validate and normalize a platform config. Throws a precise, agent-legible
 * error (with offending path) on malformed input.
 */
export function definePlatformConfig(config: PlatformConfigInput): PlatformConfig {
  const result = PlatformConfigSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid platform config:\n${issues}`);
  }
  return result.data;
}

/** Default (empty) platform config - used when no file is present at boot. */
export const defaultPlatformConfig: PlatformConfig = definePlatformConfig({});

/** DI token to inject the active PlatformConfig into services + slot fills. */
export const PLATFORM_CONFIG = Symbol('PLATFORM_CONFIG');
