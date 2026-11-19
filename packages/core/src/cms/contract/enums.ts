import * as z from 'zod';

export const BANNER_LAYOUTS = ['carousel', 'grid', 'single'] as const;
export const BannerLayoutSchema = z.enum(BANNER_LAYOUTS);
export type BannerLayout = z.infer<typeof BannerLayoutSchema>;
