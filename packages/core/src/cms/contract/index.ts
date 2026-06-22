import { oc } from '@orpc/contract';
import * as z from 'zod';
import { IdInputSchema } from '@blurifycom/core/contracts';

export const PageSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  content: z.unknown(),
  publishedAt: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const BannerSchema = z.object({
  id: z.uuid(),
  placement: z.string(),
  title: z.string(),
  imageUrl: z.string(),
  linkUrl: z.string().nullable(),
  isActive: z.boolean(),
  sortOrder: z.number(),
  createdAt: z.iso.datetime(),
});

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
        id: z.uuid(),
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

  listBanners: oc.route({ method: 'GET', path: '/cms/banners' }).output(z.array(BannerSchema)),

  listBannersByPlacement: oc
    .route({ method: 'GET', path: '/cms/banners/{placement}' })
    .input(z.object({ placement: z.string() }))
    .output(z.array(BannerSchema)),

  createBanner: oc
    .route({ method: 'POST', path: '/cms/banners' })
    .input(
      z.object({
        placement: z.string(),
        title: z.string(),
        imageUrl: z.string(),
        linkUrl: z.string().optional(),
        sortOrder: z.number().optional(),
      }),
    )
    .output(BannerSchema),

  updateBanner: oc
    .route({ method: 'PUT', path: '/cms/banners/{id}' })
    .input(
      z.object({
        id: z.uuid(),
        placement: z.string().optional(),
        title: z.string().optional(),
        imageUrl: z.string().optional(),
        linkUrl: z.string().nullable().optional(),
        isActive: z.boolean().optional(),
        sortOrder: z.number().optional(),
      }),
    )
    .output(BannerSchema),

  deleteBanner: oc
    .route({ method: 'DELETE', path: '/cms/banners/{id}' })
    .input(IdInputSchema)
    .output(z.object({ success: z.literal(true) })),
};
