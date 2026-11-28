import { z } from 'zod';
import { createToken } from '../adapters/token.js';
import { CurrencyTickerInputSchema } from './common.js';

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
    maxDepositPerDay: z.number().nonnegative().optional(),
    maxDepositPerMonth: z.number().nonnegative().optional(),
    maxLossPerDay: z.number().nonnegative().optional(),
    maxStakePerBet: z.number().nonnegative().optional(),
    sessionReminderMinutes: z.number().int().positive().optional(),
  })
  .strict();

export const ResponsibleGamingSchema = z
  .object({
    limitIncreaseCooldownHours: z.number().int().min(0).default(24),
    limitChangeConfirmationWindowHours: z.number().int().positive().default(168),
  })
  .strict();

export type ResponsibleGamingConfig = z.infer<typeof ResponsibleGamingSchema>;

export const defaultResponsibleGamingConfig: ResponsibleGamingConfig =
  ResponsibleGamingSchema.parse({});

export const ProviderSelectionSchema = z
  .object({
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
    themePreset: z.string().optional(),
    supportEmail: z.email().optional(),
  })
  .strict();

export const IgamingConfigSchema = z
  .object({
    branding: BrandingSchema,
    currencies: z.array(CurrencyTickerInputSchema).min(1),
    jurisdictions: z.array(CountryCodeSchema).min(1),
    blockedCountries: z.array(CountryCodeSchema).default([]),
    enabledModules: z.array(z.string()).optional(),
    limits: LimitsSchema.default({}),
    providers: ProviderSelectionSchema.default({}),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (!cfg.jurisdictions.every((j) => !cfg.blockedCountries.includes(j))) {
      ctx.addIssue({
        code: 'custom',
        message: 'A jurisdiction cannot also be in blockedCountries.',
        path: ['blockedCountries'],
      });
    }
  });

export type IgamingConfig = z.infer<typeof IgamingConfigSchema>;
export type IgamingConfigInput = z.input<typeof IgamingConfigSchema>;

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

export const IGAMING_CONFIG = createToken<IgamingConfig>('IGAMING_CONFIG');
