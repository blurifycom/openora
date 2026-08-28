import { z } from 'zod';
import { LimitsSchema } from './igaming-config.js';
import { MoneyAmountSchema } from './common.js';
import { createToken } from '../adapters/token.js';

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

export const KycConfigSchema = z
  .object({
    /** Provider id recorded on each verification record (e.g. 'didit', 'sumsub'). */
    provider: z.string().optional(),
    /** Name of the env var holding the webhook HMAC secret. Default: KYC_WEBHOOK_SECRET. */
    webhookSecretEnv: z.string().optional(),
    /** When true, withdrawals require a passing KYC status (verified|manually_overridden). */
    gateWithdrawals: z.boolean().default(false),
    /**
     * Per-currency cumulative-deposit thresholds (currency code -> decimal string)
     * that trigger a re-KYC of a verified player. Absent currency = no threshold for that currency.
     */
    reverifyThresholds: z.record(z.string(), MoneyAmountSchema).optional(),
  })
  .strict();

export const AutoWithdrawalConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Amount cap on auto-approved payouts per player per trailing 24h. Absent = no cap. */
    dailyCapAmount: MoneyAmountSchema.optional(),
    /** Count cap on auto-approved payouts per player per trailing 24h. Absent = no cap. */
    dailyCapCount: z.number().int().positive().optional(),
  })
  .strict();

export type AutoWithdrawalConfig = z.infer<typeof AutoWithdrawalConfigSchema>;

export const WalletConfigSchema = z
  .object({
    /**
     * Currency codes routed to the crypto rail by `railFor` (case-insensitive).
     * Absent = the built-in default (BTC, ETH, USDT, USDC). Lets an operator add or
     * swap crypto assets (eg a custody vendor's supported asset list) without a
     * core code change.
     */
    cryptoCurrencies: z.array(z.string().min(1)).optional(),
    /**
     * Vendor-side account each provider's sweeps move player funds into, keyed by the
     * provider name in `wallet_asset.providerName` (`default` for the single bound
     * adapter). Keyed rather than flat because one operator can run several vendors,
     * and an account id only means something at the vendor that issued it. A provider
     * with no entry sweeps to whatever its adapter defaults to.
     */
    treasuryRefs: z.record(z.string().min(1), z.string().min(1)).optional(),
    /**
     * Custody sweep cron knobs. Static config, not a DB row - nothing here is edited
     * during an incident. Absent means the sweep job no-ops.
     */
    sweep: z
      .object({
        cron: z.string().default('*/15 * * * *'),
        /**
         * Decimal string, compared exactly (see `moneyCompare`/`moneyScaleBy`). A
         * balance must be worth at least this many times the fee to be worth sweeping.
         */
        feeMultiple: MoneyAmountSchema.default('5'),
        /** Balances considered per cycle; listSweepableBalances is unbounded. */
        batchSize: z.number().int().positive().default(200),
        /** Vendor API parallelism. Tune to the vendor's rate limit. */
        concurrency: z.number().int().positive().default(4),
        /**
         * How long a sweep may sit in `unknown` before reconciliation reports it for a
         * human. `unknown` means the vendor call threw and we cannot tell whether it
         * was received, so the in-flight guard stays held and nobody releases it
         * automatically.
         */
        unknownAfterMinutes: z.number().int().positive().default(60),
        /**
         * How long a claimed run may sit unfinished before another cycle treats it as
         * abandoned and takes over. Distinct from `unknownAfterMinutes`: this one is
         * about a crashed worker, that one is about an ambiguous vendor call.
         */
        staleRunAfterMinutes: z.number().int().positive().default(30),
      })
      .strict()
      .optional(),
    /**
     * Reconciliation cron knobs. Static config, not a DB row - nothing here is edited
     * during an incident. Absent means the reconciliation job no-ops.
     */
    reconciliation: z
      .object({
        cron: z.string().default('0 * * * *'),
        lookbackHours: z.number().int().positive().default(24),
        batchSize: z.number().int().positive().default(200),
        stuckAfterMinutes: z.number().int().positive().default(60),
        /** Run-claim takeover threshold, as in `sweep.staleRunAfterMinutes`. */
        staleRunAfterMinutes: z.number().int().positive().default(30),
        alertThreshold: z.number().int().positive().default(10),
      })
      .strict()
      .optional(),
  })
  .strict();

export type WalletConfig = z.infer<typeof WalletConfigSchema>;

export const RegistrationConfigSchema = z
  .object({
    /** Version recorded beside the player's affirmative terms acceptance. */
    termsVersion: z.string().min(1),
    /**
     * Blocks sign-in until the player has verified their address. Off by default:
     * unverified players stay unrestricted while the KYC toggle is off.
     */
    requireEmailVerification: z.boolean().default(false),
  })
  .strict();

export const ChatConfigSchema = z
  .object({
    /** Hostnames a chat message attachment may be served from. Empty = attachments disabled. */
    allowedAttachmentHosts: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ChatConfig = z.infer<typeof ChatConfigSchema>;

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
     * RG default limits per ISO 3166-1 alpha-2 country code (jurisdiction
     * defaults), reusing the shared LimitsSchema shape.
     */
    rgLimits: z.record(z.string().length(2), LimitsSchema).default({}),
    /**
     * KYC verification knobs: provider id, webhook secret env, withdrawal gating,
     * and per-currency re-KYC deposit thresholds. Absent = KYC ungated, no re-KYC.
     */
    kyc: KycConfigSchema.optional(),
    /** Auto-approve withdrawals that clear every risk gate instead of queuing them for manual review. Absent = always manual. */
    autoWithdrawal: AutoWithdrawalConfigSchema.optional(),
    /** Wallet rail-routing knobs (currently: the crypto currency set). Absent = built-in default. */
    wallet: WalletConfigSchema.optional(),
    /** Required before public registration is enabled. */
    registration: RegistrationConfigSchema.optional(),
    /**
     * Player-facing language codes the operator supports (eg `['en', 'es']`).
     * Undefined or empty means no restriction - any value is accepted.
     */
    supportedLanguages: z.array(z.string().min(1)).optional(),
    /** Chat attachment host allow-list. Absent = built-in default (empty = disabled). */
    chat: ChatConfigSchema.default({ allowedAttachmentHosts: [] }),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.activeBrand && !cfg.brands.some((b) => b.id === cfg.activeBrand)) {
      ctx.addIssue({
        code: 'custom',
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
export const PLATFORM_CONFIG = createToken<PlatformConfig>('PLATFORM_CONFIG');
