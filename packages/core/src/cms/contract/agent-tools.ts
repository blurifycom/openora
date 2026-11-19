import * as z from 'zod';
import { TimestampSchema, UuidSchema, defineMcpTool } from '@openora/core/contracts';
import { BannerLayoutSchema } from './enums.js';

/** At most this many banner configurations cms.banners lists. */
export const CMS_BANNERS_MAX = 100;
/** At most this many image locales cms.banners lists per configuration. */
export const CMS_BANNER_MAX_LOCALES = 50;

export const CmsBannersInputSchema = z.object({
  placement: z.string().min(1).max(100).optional(),
});
export type CmsBannersInput = z.infer<typeof CmsBannersInputSchema>;

export const CmsBannersOutputSchema = z.object({
  banners: z
    .array(
      z.object({
        bannerId: UuidSchema,
        placement: z.string(),
        layout: BannerLayoutSchema,
        isDefault: z.boolean(),
        imageCount: z.number().int().nonnegative(),
        locales: z.array(z.string()).max(CMS_BANNER_MAX_LOCALES),
        liveNow: z.boolean(),
        nextStartsAt: TimestampSchema.nullable(),
      }),
    )
    .max(CMS_BANNERS_MAX),
  truncated: z.boolean(),
});
export type CmsBanners = z.infer<typeof CmsBannersOutputSchema>;

export const cmsBannersTool = defineMcpTool({
  id: 'cms.banners',
  title: 'Banners',
  description:
    'Lists the banner configurations by placement, each with its bannerId, placement, layout ' +
    '(carousel, grid or single), isDefault (the standing one of its placement), imageCount (its ' +
    'images over every locale), the locales its images are in, liveNow and nextStartsAt. ' +
    'liveNow is true when it is what its placement shows now: its schedule covers now, or it is ' +
    'the default and no schedule of the placement covers now. nextStartsAt is when its schedule ' +
    'starts, while that is still ahead, else null. placement narrows them to one placement. At ' +
    'most 100, the default first in each placement, then newest; truncated is true when there ' +
    'are more. No image URL, link or author is returned.',
  class: 'read',
  schemaVersion: 1,
  // The banner admin reads assert content:update; content has no view action.
  iam: { resource: 'content', action: 'update' },
  inputSchema: CmsBannersInputSchema,
  outputSchema: CmsBannersOutputSchema,
  redact: { allow: ['banners', 'truncated'] },
  errors: [],
});
