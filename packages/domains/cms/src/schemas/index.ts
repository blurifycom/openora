import { z } from 'zod';
import { PageSchema, BannerSchema } from '../contract/index.js';

export * from '@oss/shared-schemas';
export { PageSchema, BannerSchema, cmsContract } from '../contract/index.js';

export type Page = z.infer<typeof PageSchema>;
export type Banner = z.infer<typeof BannerSchema>;
