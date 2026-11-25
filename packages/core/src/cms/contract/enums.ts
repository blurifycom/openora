import * as z from 'zod';
import { BANNER_LAYOUTS, type BannerLayout } from '@openora/core/contracts';

export { BANNER_LAYOUTS, type BannerLayout };
export const BannerLayoutSchema = z.enum(BANNER_LAYOUTS);
