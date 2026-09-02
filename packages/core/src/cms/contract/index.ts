import { oc } from '@orpc/contract';
import * as z from 'zod';
import { IdInputSchema, TimestampSchema, UuidSchema } from '@openora/core/contracts';

export const PageSchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  title: z.string(),
  content: z.unknown(),
  publishedAt: z.string().nullable(),
  createdAt: TimestampSchema,
});
export type Page = z.infer<typeof PageSchema>;

export const BANNER_LAYOUTS = ['carousel', 'grid', 'single'] as const;
export const BannerLayoutSchema = z.enum(BANNER_LAYOUTS);
export type BannerLayout = z.infer<typeof BannerLayoutSchema>;

export const BANNER_IMAGE_COUNT_BOUNDS: Record<BannerLayout, { min: number; max: number }> = {
  carousel: { min: 2, max: 6 },
  grid: { min: 3, max: 3 },
  single: { min: 1, max: 1 },
};

export const DEFAULT_LOCALE = 'default';

function isSafeInternalBannerPath(value: string): boolean {
  return /^\/(?![\\/])/.test(value);
}
function isSafeExternalBannerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
export const BannerLinkUrlSchema = z
  .string()
  .min(1)
  .refine((value) => isSafeInternalBannerPath(value) || isSafeExternalBannerUrl(value), {
    message:
      'linkUrl must be an internal path starting with a single "/" (not "//" or "/\\") or a well-formed http(s) URL',
  });

export const BannerImageSchema = z.object({
  id: UuidSchema,
  bannerConfigurationId: UuidSchema,
  sortOrder: z.number().int().min(0),
  locale: z.string(),
  desktopImageUrl: z.string(),
  mobileImageUrl: z.string(),
  linkUrl: z.string().nullable(),
  createdAt: TimestampSchema,
});
export type BannerImage = z.infer<typeof BannerImageSchema>;

export const BannerConfigurationSchema = z.object({
  id: UuidSchema,
  placement: z.string(),
  layout: BannerLayoutSchema,
  isDefault: z.boolean(),
  createdBy: UuidSchema,
  createdAt: TimestampSchema,
  images: z.array(BannerImageSchema),
});
export type BannerConfiguration = z.infer<typeof BannerConfigurationSchema>;

export const BannerConfigurationSummarySchema = BannerConfigurationSchema.omit({
  images: true,
}).extend({
  imageCount: z.number().int().min(0),
});
export type BannerConfigurationSummary = z.infer<typeof BannerConfigurationSummarySchema>;

export const BannerPlacementSummarySchema = z.object({
  placement: z.string(),
  defaultConfigurationId: UuidSchema.nullable(),
  defaultConfiguration: BannerConfigurationSchema.nullable(),
  updatedAt: TimestampSchema,
});
export type BannerPlacementSummary = z.infer<typeof BannerPlacementSummarySchema>;

export const PublicBannerSlotSchema = z.object({
  sortOrder: z.number().int(),
  desktopImageUrl: z.string(),
  mobileImageUrl: z.string(),
  linkUrl: z.string().nullable(),
});
export type PublicBannerSlot = z.infer<typeof PublicBannerSlotSchema>;

export const PublicBannerSchema = z.object({
  placement: z.string(),
  layout: BannerLayoutSchema,
  slots: z.array(PublicBannerSlotSchema),
});
export type PublicBanner = z.infer<typeof PublicBannerSchema>;

export const CreateBannerConfigurationInputSchema = z.object({
  placement: z.string(),
  layout: BannerLayoutSchema,
});
export type CreateBannerConfigurationInput = z.infer<typeof CreateBannerConfigurationInputSchema>;

export const ListBannerConfigurationsInputSchema = z.object({
  placement: z.string(),
});
export type ListBannerConfigurationsInput = z.infer<typeof ListBannerConfigurationsInputSchema>;

export const GetBannerConfigurationInputSchema = IdInputSchema;
export const DeleteBannerConfigurationInputSchema = IdInputSchema;

export const SetDefaultBannerConfigurationInputSchema = IdInputSchema;

export const UnsetDefaultBannerConfigurationInputSchema = z.object({
  placement: z.string(),
});
export type UnsetDefaultBannerConfigurationInput = z.infer<
  typeof UnsetDefaultBannerConfigurationInputSchema
>;

export const SetBannerImageInputSchema = z.object({
  bannerConfigurationId: UuidSchema,
  sortOrder: z.number().int().min(0),
  locale: z.string().optional(),
  desktopImageUrl: z.string(),
  mobileImageUrl: z.string(),
  linkUrl: BannerLinkUrlSchema.nullable().optional(),
});
export type SetBannerImageInput = z.infer<typeof SetBannerImageInputSchema>;

export const DeleteBannerImageInputSchema = IdInputSchema;

export const GetPublicBannerInputSchema = z.object({
  placement: z.string(),
  locale: z.string().optional(),
});
export type GetPublicBannerInput = z.infer<typeof GetPublicBannerInputSchema>;

export const cmsContract = {
  listPages: oc
    .route({ method: 'GET', path: '/cms/pages' })
    .output(z.array(PageSchema.omit({ content: true }))),

  getPage: oc
    .route({ method: 'GET', path: '/cms/pages/{slug}' })
    .input(z.object({ slug: z.string() }))
    .output(PageSchema),

  createPage: oc
    .route({ method: 'POST', path: '/cms/pages' })
    .input(
      z.object({
        slug: z.string(),
        title: z.string(),
        content: z.unknown().optional(),
        publishedAt: z.string().optional(),
      }),
    )
    .output(PageSchema),

  updatePage: oc
    .route({ method: 'PUT', path: '/cms/pages/{id}' })
    .input(
      z.object({
        id: UuidSchema,
        slug: z.string().optional(),
        title: z.string().optional(),
        content: z.unknown().optional(),
        publishedAt: z.string().nullable().optional(),
      }),
    )
    .output(PageSchema),

  deletePage: oc
    .route({ method: 'DELETE', path: '/cms/pages/{id}' })
    .input(IdInputSchema)
    .output(z.object({ success: z.literal(true) })),

  listBannerPlacements: oc
    .route({ method: 'GET', path: '/cms/banner-placements' })
    .output(z.array(BannerPlacementSummarySchema)),

  listBannerConfigurationsByPlacement: oc
    .route({ method: 'GET', path: '/cms/banner-placements/{placement}/configurations' })
    .input(ListBannerConfigurationsInputSchema)
    .output(z.array(BannerConfigurationSummarySchema)),

  unsetDefaultBannerConfiguration: oc
    .route({ method: 'POST', path: '/cms/banner-placements/{placement}/unset-default' })
    .input(UnsetDefaultBannerConfigurationInputSchema)
    .output(BannerPlacementSummarySchema),

  getBannerConfiguration: oc
    .route({ method: 'GET', path: '/cms/banner-configurations/{id}' })
    .input(GetBannerConfigurationInputSchema)
    .output(BannerConfigurationSchema),

  createBannerConfiguration: oc
    .route({ method: 'POST', path: '/cms/banner-configurations' })
    .input(CreateBannerConfigurationInputSchema)
    .output(BannerConfigurationSchema),

  deleteBannerConfiguration: oc
    .route({ method: 'DELETE', path: '/cms/banner-configurations/{id}' })
    .input(DeleteBannerConfigurationInputSchema)
    .output(z.object({ success: z.literal(true) })),

  setDefaultBannerConfiguration: oc
    .route({ method: 'POST', path: '/cms/banner-configurations/{id}/set-default' })
    .input(SetDefaultBannerConfigurationInputSchema)
    .output(BannerPlacementSummarySchema),

  setBannerImage: oc
    .route({ method: 'PUT', path: '/cms/banner-images' })
    .input(SetBannerImageInputSchema)
    .output(BannerImageSchema),

  deleteBannerImage: oc
    .route({ method: 'DELETE', path: '/cms/banner-images/{id}' })
    .input(DeleteBannerImageInputSchema)
    .output(z.object({ success: z.literal(true) })),

  getPublicBanner: oc
    .route({ method: 'GET', path: '/cms/banners/{placement}' })
    .input(GetPublicBannerInputSchema)
    .output(PublicBannerSchema.nullable()),
};
