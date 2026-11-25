import { z } from 'zod';

export const BANNER_LAYOUTS = ['carousel', 'grid', 'single'] as const;
export type BannerLayout = (typeof BANNER_LAYOUTS)[number];
export const BannerLayoutSchema = z.enum(BANNER_LAYOUTS);

/** Image-count bounds a banner configuration must satisfy before it can go live, per layout. */
export const BANNER_IMAGE_COUNT_BOUNDS: Record<BannerLayout, { min: number; max: number }> = {
  carousel: { min: 2, max: 6 },
  grid: { min: 3, max: 3 },
  single: { min: 1, max: 1 },
};

/**
 * Per-placement replacement for a layout's default bounds: placement -> layout -> bounds.
 * A layout without an entry keeps its default. `min` is at least 1 (a live banner is never
 * empty), `max` at most the layout's own maximum, and `min <= max`.
 */
export const BannerImageCountBoundsOverridesSchema = z
  .record(
    z.string().min(1),
    z.partialRecord(
      BannerLayoutSchema,
      z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).strict(),
    ),
  )
  .superRefine((overrides, ctx) => {
    for (const [placement, layouts] of Object.entries(overrides)) {
      for (const layout of BANNER_LAYOUTS) {
        const bounds = layouts[layout];
        if (!bounds) {
          continue;
        }
        const hardMax = BANNER_IMAGE_COUNT_BOUNDS[layout].max;
        const issue = (message: string) =>
          ctx.addIssue({ code: 'custom', message, path: [placement, layout] });
        if (bounds.min > bounds.max) {
          issue(`min ${bounds.min} is above max ${bounds.max}`);
        } else if (bounds.max > hardMax) {
          issue(`max ${bounds.max} is above the ${layout} layout's maximum of ${hardMax}`);
        }
      }
    }
  });
export type BannerImageCountBoundsOverrides = z.infer<typeof BannerImageCountBoundsOverridesSchema>;
