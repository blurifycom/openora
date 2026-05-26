import { z } from 'zod';
import { PageSchema, BannerSchema } from '@oss/orpc-contract';

export * from '@oss/shared-schemas';
export { PageSchema, BannerSchema, cmsContract } from '@oss/orpc-contract';

export type Page = z.infer<typeof PageSchema>;
export type Banner = z.infer<typeof BannerSchema>;
