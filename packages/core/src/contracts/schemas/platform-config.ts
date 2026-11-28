import { z } from 'zod';
import {
  LimitsSchema,
  CurrencyCodeSchema,
  ResponsibleGamingSchema,
  defaultResponsibleGamingConfig,
} from './igaming-config.js';
import { CurrencyTickerInputSchema, MoneyAmountSchema } from './common.js';
import { AgentsConfigSchema } from './agents.js';
import { HostAllowlistEntrySchema, UrlPrefixAllowlistEntrySchema } from './host-allowlist.js';
import { createToken } from '../adapters/token.js';
import { BannerImageCountBoundsOverridesSchema } from './cms-banner.js';
import { MIN_PLAYER_AGE_YEARS } from './player.js';
import { TurnoverCreditTypeSchema } from '../adapters/turnover.js';
import { WagerProductSchema } from '../adapters/wager-context.js';
import { GRANT_CONCURRENCY_MODES, RANK_PERIODIC_BASES, RANK_PROGRESS_BASES } from './promo.js';

export const FeatureFlagsSchema = z.record(z.string(), z.boolean());

export const BrandSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    themePreset: z.string().optional(),
    themeOverrides: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const KycConfigSchema = z
  .object({
    provider: z.string().optional(),
    webhookSecretEnv: z.string().optional(),
    gateWithdrawals: z.boolean().default(false),
    requireApprovalForDirectOverride: z.boolean().default(false),
    reverifyThresholds: z.record(z.string(), MoneyAmountSchema).optional(),
  })
  .strict();

export const AutoWithdrawalConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    dailyCapAmount: MoneyAmountSchema.optional(),
    dailyCapCount: z.number().int().positive().optional(),
  })
  .strict();

export type AutoWithdrawalConfig = z.infer<typeof AutoWithdrawalConfigSchema>;

export const CronExpressionSchema = z
  .string()
  .regex(
    /^[0-9A-Za-z*?,\-/]+( [0-9A-Za-z*?,\-/]+){4,5}$/,
    'must be a 5- or 6-field cron expression',
  );

export const TurnoverPercentSchema = z.number().int().min(0).max(100);

const TURNOVER_DEFAULT_LOCKED_MESSAGE = 'Wager your deposits before withdrawing or sending funds.';

export const WalletTurnoverConfigSchema = z
  .object({
    multiplier: MoneyAmountSchema.default('0'),
    creditTypes: z.array(TurnoverCreditTypeSchema).default(['deposit']),
    productPercent: z
      .object({
        casino: TurnoverPercentSchema.default(100),
        'live-casino': TurnoverPercentSchema.default(100),
        sportsbook: TurnoverPercentSchema.default(100),
        pvp: TurnoverPercentSchema.default(0),
      })
      .strict()
      .prefault({}),
    countAtSettle: z.array(WagerProductSchema).default(['sportsbook']),
    dustThreshold: MoneyAmountSchema.default('0.01'),
    pricingCron: CronExpressionSchema.default('*/5 * * * *'),
    lockedMessage: z.string().min(1).default(TURNOVER_DEFAULT_LOCKED_MESSAGE),
  })
  .strict();

export type WalletTurnoverConfig = z.infer<typeof WalletTurnoverConfigSchema>;

export const WALLET_TRANSFER_CREDIT_MODES = ['bonus_grant', 'cash'] as const;
export const WALLET_TRANSFER_CREDIT_KINDS = ['gift', 'rain', 'donation'] as const;

export const WalletConfigSchema = z
  .object({
    turnover: WalletTurnoverConfigSchema.optional(),
    transferCredits: z.enum(WALLET_TRANSFER_CREDIT_MODES).optional(),
    cryptoCurrencies: z.array(z.string().min(1)).optional(),
    defaultCurrency: CurrencyTickerInputSchema.optional(),
    defaultReferenceCurrency: CurrencyTickerInputSchema.optional(),
    significantAmountThresholds: z
      .record(z.string(), MoneyAmountSchema)
      .refine(
        (thresholds) =>
          new Set(Object.keys(thresholds).map((code) => code.toUpperCase())).size ===
          Object.keys(thresholds).length,
        'a currency appears twice, ignoring case',
      )
      .optional(),
    treasuryRefs: z.record(z.string().min(1), z.string().min(1)).optional(),
    sweep: z
      .object({
        cron: z.string().default('*/15 * * * *'),
        feeMultiple: MoneyAmountSchema.default('5'),
        batchSize: z.number().int().positive().default(200),
        concurrency: z.number().int().positive().default(4),
        unknownAfterMinutes: z.number().int().positive().default(60),
        staleRunAfterMinutes: z.number().int().positive().default(30),
      })
      .strict()
      .optional(),
    reconciliation: z
      .object({
        cron: z.string().default('0 * * * *'),
        lookbackHours: z.number().int().positive().default(24),
        batchSize: z.number().int().positive().default(200),
        stuckAfterMinutes: z.number().int().positive().default(60),
        stuckSwapAfterMinutes: z.number().int().positive().optional(),
        staleRunAfterMinutes: z.number().int().positive().default(30),
        alertThreshold: z.number().int().positive().default(10),
        ledgerInvariantCron: z.string().optional(),
        ledgerInvariantStaleRunAfterMinutes: z.number().int().positive().optional(),
        outboxLagAlertMinutes: z.number().int().positive().default(5),
        deadLetterAlertThreshold: z.number().int().nonnegative().default(0),
      })
      .strict()
      .optional(),
  })
  .strict();

export type WalletConfig = z.infer<typeof WalletConfigSchema>;

const DEFAULT_WALLET_CURRENCY = 'USD';

export function resolveWalletDefaultCurrency(config: WalletConfig | undefined): string {
  return (config?.defaultCurrency ?? DEFAULT_WALLET_CURRENCY).toUpperCase();
}

const DEFAULT_REFERENCE_CURRENCY = 'USD';

export function resolveWalletReferenceCurrency(config: WalletConfig | undefined): string {
  return (config?.defaultReferenceCurrency ?? DEFAULT_REFERENCE_CURRENCY).toUpperCase();
}

export function resolveWalletTurnoverConfig(
  config: WalletConfig | undefined,
): WalletTurnoverConfig {
  return WalletTurnoverConfigSchema.parse(config?.turnover ?? {});
}

export function isTurnoverEnabled({
  multiplier,
}: Pick<WalletTurnoverConfig, 'multiplier'>): boolean {
  return /[1-9]/.test(multiplier);
}

const DEFAULT_EXCHANGE_RATE_PIVOT = 'USD';

export const ExchangeRateConfigSchema = z
  .object({
    pivot: CurrencyCodeSchema.default(DEFAULT_EXCHANGE_RATE_PIVOT),
    freshTtlMs: z.number().int().positive().default(60_000),
    hardMaxAgeMs: z
      .number()
      .int()
      .positive()
      .default(15 * 60_000),
    providerTimeoutMs: z.number().int().positive().default(2_000),
    failureCooldownMs: z.number().int().positive().default(30_000),
  })
  .strict();

export type ExchangeRateConfig = z.infer<typeof ExchangeRateConfigSchema>;

export function resolveExchangeRatePivot(config: ExchangeRateConfig | undefined): string {
  return (config?.pivot ?? DEFAULT_EXCHANGE_RATE_PIVOT).toUpperCase();
}

export const NotificationsConfigSchema = z
  .object({
    retention: z
      .object({
        days: z.number().int().positive().default(30),
        cron: z.string().default('0 3 * * *'),
      })
      .strict()
      .optional(),
  })
  .strict();

export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;

export const RegistrationConfigSchema = z
  .object({
    termsVersion: z.string().min(1),
    requireEmailVerification: z.boolean().default(false),
    minPlayerAge: z.number().int().min(MIN_PLAYER_AGE_YEARS).default(MIN_PLAYER_AGE_YEARS),
  })
  .strict();

export const CHAT_MODERATION_EXPIRY_DEFAULT_CRON = '7,22,37,52 * * * *';

export const RANK_PAYOUT_DEFAULT_CRON = '3,13,23,33,43,53 * * * *';
export const RANK_PERIODIC_DEFAULT_CRON = '17 * * * *';
export const STREAK_PAYOUT_DEFAULT_CRON = '7,27,47 * * * *';
export const STREAK_CLOSE_DEFAULT_CRON = '5 0 * * *';

export const RAKEBACK_BASES = ['stake', 'margin'] as const;
export const RAKEBACK_PAYOUTS = ['instant', 'claim'] as const;
export type RakebackBasis = (typeof RAKEBACK_BASES)[number];
export type RakebackPayout = (typeof RAKEBACK_PAYOUTS)[number];

export const BONUS_WITHDRAWAL_MODES = ['block', 'forfeit'] as const;
export type BonusWithdrawalMode = (typeof BONUS_WITHDRAWAL_MODES)[number];
export const DEFAULT_LOCKED_FUNDS_MESSAGE =
  'Part of this balance is tied to an active bonus and cannot be moved until the bonus ends';

export const PromoConfigSchema = z
  .object({
    bonus: z
      .object({
        grantConcurrency: z.enum(GRANT_CONCURRENCY_MODES).default('multiple'),
        withdrawalWhileActive: z.enum(BONUS_WITHDRAWAL_MODES).default('forfeit'),
        lockedFundsMessage: z.string().min(1).default(DEFAULT_LOCKED_FUNDS_MESSAGE),
      })
      .strict()
      .prefault({}),
    ranks: z
      .object({
        payoutCron: CronExpressionSchema.default(RANK_PAYOUT_DEFAULT_CRON),
        periodicCron: CronExpressionSchema.default(RANK_PERIODIC_DEFAULT_CRON),
        progressBasis: z.enum(RANK_PROGRESS_BASES).default('total'),
      })
      .strict()
      .prefault({}),
    streaks: z
      .object({
        payoutCron: CronExpressionSchema.default(STREAK_PAYOUT_DEFAULT_CRON),
        closeCron: CronExpressionSchema.default(STREAK_CLOSE_DEFAULT_CRON),
      })
      .strict()
      .prefault({}),
    rakeback: z
      .object({
        basis: z.enum(RAKEBACK_BASES).default('stake'),
        payout: z.enum(RAKEBACK_PAYOUTS).default('instant'),
        claimMinimum: MoneyAmountSchema.default('0'),
      })
      .strict()
      .prefault({}),
    rankPeriodic: z
      .object({
        basis: z.enum(RANK_PERIODIC_BASES).default('flat'),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type PromoConfig = z.infer<typeof PromoConfigSchema>;

export const ChatConfigSchema = z
  .object({
    allowedAttachmentHosts: z.array(HostAllowlistEntrySchema).default([]),
    moderationExpiry: z
      .object({
        cron: CronExpressionSchema.default(CHAT_MODERATION_EXPIRY_DEFAULT_CRON),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ChatConfig = z.infer<typeof ChatConfigSchema>;

export const AdminSecurityConfigSchema = z
  .object({
    requireTwoFactor: z.boolean().default(false),
    bindSessionToDevice: z.boolean().default(false),
    trustedDeviceDays: z.number().int().min(0).max(90).default(30),
    ipChangePolicy: z.enum(['off', 'country', 'any']).default('off'),
    twoFactorLockout: z
      .object({
        maxAttempts: z.number().int().min(1).max(20).default(5),
        durationMs: z
          .number()
          .int()
          .min(0)
          .default(15 * 60 * 1000),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type AdminSecurityConfig = z.infer<typeof AdminSecurityConfigSchema>;

export const CmsConfigSchema = z
  .object({
    allowedBannerImageHosts: z.array(HostAllowlistEntrySchema).default([]),
    bannerImageCountBounds: BannerImageCountBoundsOverridesSchema.default({}),
  })
  .strict();
export type CmsConfig = z.infer<typeof CmsConfigSchema>;

export const GamingConfigSchema = z
  .object({
    allowedThumbnailHosts: z.array(HostAllowlistEntrySchema).default([]),
  })
  .strict();
export type GamingConfig = z.infer<typeof GamingConfigSchema>;

export const IdentityConfigSchema = z
  .object({
    allowedAvatarHosts: z.array(HostAllowlistEntrySchema).default([]),
    allowedAvatarUrlPrefixes: z.array(UrlPrefixAllowlistEntrySchema).default([]),
  })
  .strict();
export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;

export const LobbyConfigSchema = z
  .object({
    keyedLayouts: z.boolean().default(false),
  })
  .strict();
export type LobbyConfig = z.infer<typeof LobbyConfigSchema>;

export const PlatformConfigSchema = z
  .object({
    features: FeatureFlagsSchema.default({}),
    brands: z.array(BrandSchema).default([]),
    activeBrand: z.string().optional(),
    rgLimits: z.record(z.string().length(2), LimitsSchema).default({}),
    responsibleGambling: ResponsibleGamingSchema.default(defaultResponsibleGamingConfig),
    kyc: KycConfigSchema.optional(),
    autoWithdrawal: AutoWithdrawalConfigSchema.optional(),
    wallet: WalletConfigSchema.optional(),
    exchangeRate: ExchangeRateConfigSchema.optional(),
    registration: RegistrationConfigSchema.optional(),
    notifications: NotificationsConfigSchema.optional(),
    supportedLanguages: z.array(z.string().min(1)).optional(),
    displayCurrencies: z.array(z.string().min(1)).optional(),
    reservedUsernames: z.array(z.string().min(1)).optional(),
    chat: ChatConfigSchema.default({ allowedAttachmentHosts: [] }),
    adminSecurity: AdminSecurityConfigSchema.prefault({}),
    cms: CmsConfigSchema.prefault({}),
    gaming: GamingConfigSchema.default({ allowedThumbnailHosts: [] }),
    identity: IdentityConfigSchema.default({
      allowedAvatarHosts: [],
      allowedAvatarUrlPrefixes: [],
    }),
    lobby: LobbyConfigSchema.prefault({}),
    promo: PromoConfigSchema.prefault({}),
    agents: AgentsConfigSchema.prefault({}),
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

export function resolvePromoConfig(config: Pick<PlatformConfig, 'promo'> | undefined): PromoConfig {
  return PromoConfigSchema.parse(config?.promo ?? {});
}

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

export const defaultPlatformConfig: PlatformConfig = definePlatformConfig({});

export const PLATFORM_CONFIG = createToken<PlatformConfig>('PLATFORM_CONFIG');

export function resolveMinPlayerAge(config?: PlatformConfig): number {
  return Math.max(MIN_PLAYER_AGE_YEARS, config?.registration?.minPlayerAge ?? MIN_PLAYER_AGE_YEARS);
}
